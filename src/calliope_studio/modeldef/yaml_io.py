"""Comment-preserving YAML round-trip.

This is the load-bearing primitive of the editor. Every structured editor in the
frontend reads a top-level section, edits it as a plain object, and writes it
back; everything outside that section — comments, ordering, quote style, blank
lines — has to survive untouched. `ruamel.yaml` in round-trip mode is what makes
that possible, and it is why this layer stays in Python.

One known and unavoidable exception: ruamel normalises boolean literals when it
re-emits them, so `True` becomes `true`. This happens on a plain load-and-dump
with no edit at all, so it is not something the merge below can prevent. The two
spellings are identical to every YAML parser, including Calliope's, and
`tests/test_yaml_io.py` asserts that it is the *only* difference a rewrite ever
introduces.
"""

import copy
import io
import math
import re
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.error import YAMLError

from calliope_studio.modeldef.paths import write_text_atomic

#: A block sequence item, capturing its indentation.
_SEQUENCE_ITEM = re.compile(r"^(?P<indent>[ ]*)-[ \n]")
#: A mapping key at the start of a line.
_MAPPING_KEY = re.compile(r"^(?P<indent>[ ]*)[^\s#-][^:]*:\s*(#.*)?$")


class SectionNotFound(KeyError):
    """Raised when a requested top-level section is absent from a file."""


def _detect_sequence_indent(text: str) -> tuple[int, int]:
    """Infers how a document indents block sequences.

    ruamel emits sequences using one global setting, but real files differ: some
    put the dash at the parent key's column, others indent it. Guessing wrong
    reflows every list in the file and shifts its trailing comments, which is
    exactly the kind of spurious diff that makes an editor untrustworthy.

    Returns:
        `(sequence, offset)` for `YAML.indent`, defaulting to ruamel's own.
    """
    key_indent: int | None = None
    for line in text.splitlines():
        item = _SEQUENCE_ITEM.match(line)
        if item and key_indent is not None:
            offset = len(item.group("indent")) - key_indent
            if offset >= 0:
                return offset + 2, offset
            return 4, 2
        key = _MAPPING_KEY.match(line)
        if key:
            key_indent = len(key.group("indent"))
    return 4, 2


def _round_trip_yaml(text: str | None = None) -> YAML:
    yaml = YAML(typ="rt")
    yaml.preserve_quotes = True
    # ruamel wraps scalars at 80 columns by default, which folds long math
    # expressions and descriptions across lines the user never edited. Wrapping
    # is semantically harmless but makes for an alarming diff.
    yaml.width = 4096
    if text is not None:
        sequence, offset = _detect_sequence_indent(text)
        yaml.indent(mapping=2, sequence=sequence, offset=offset)
    return yaml


#: How a non-finite float travels over JSON, which cannot represent one.
#:
#: The spelling is YAML's own, so the editor shows `.inf` in the field — which is
#: both what the file says and what a user would type to mean it. The previous
#: mapping to `None` was worse than it looked: an unbounded parameter appeared as
#: an *empty* field, and the editors drop empty values, so opening the techs
#: editor and pressing Save deleted every `.inf` line in the user's file.
NON_FINITE = {float("inf"): ".inf", float("-inf"): "-.inf"}
NON_FINITE_NAMES = {".inf": float("inf"), "-.inf": float("-inf"), ".nan": float("nan")}


def to_plain(obj: Any) -> Any:
    """Converts ruamel's comment-carrying containers to plain Python.

    Non-finite floats become their YAML spelling as a string; see `NON_FINITE`.
    """
    if isinstance(obj, CommentedMap):
        return {key: to_plain(value) for key, value in obj.items()}
    if isinstance(obj, CommentedSeq):
        return [to_plain(value) for value in obj]
    if isinstance(obj, dict):
        return {key: to_plain(value) for key, value in obj.items()}
    if isinstance(obj, list):
        return [to_plain(value) for value in obj]
    if isinstance(obj, float) and not math.isfinite(obj):
        return NON_FINITE.get(obj, ".nan")
    return obj


def from_plain(obj: Any) -> Any:
    """The inverse of `to_plain`, applied to whatever the frontend sends back.

    Only the three YAML spellings are converted, and only from strings. No real
    Calliope value is the literal text `.inf`, so there is nothing to collide
    with — and being explicit about the set keeps this from turning into a
    general-purpose "parse anything that looks like a number".
    """
    if isinstance(obj, dict):
        return {key: from_plain(value) for key, value in obj.items()}
    if isinstance(obj, list):
        return [from_plain(value) for value in obj]
    if isinstance(obj, str) and obj in NON_FINITE_NAMES:
        return NON_FINITE_NAMES[obj]
    return obj


def _read(path: Path) -> str:
    """Reads a YAML file as UTF-8.

    Explicit, everywhere. `read_text` with no encoding uses the locale default,
    so on a Western Windows box a file holding `µ` or a CJK comment opened
    through `deps.require_text` (which does say utf-8) and then saved back as
    cp1252 — or raised `UnicodeEncodeError` and 500ed. The next open decoded
    those bytes as replacement characters, and the save after that wrote the
    replacements. Silent corruption of a model file, on a platform the suite
    runs on.
    """
    return Path(path).read_text(encoding="utf-8")


def load(path: Path) -> Any:
    """Loads a YAML document in round-trip mode, preserving formatting."""
    return _round_trip_yaml().load(_read(path))


def read_section(path: Path, section: str) -> Any:
    """Reads one top-level section as plain Python.

    Raises:
        SectionNotFound: If the document is empty or lacks the section.
    """
    document = load(path)
    if document is None or section not in document:
        raise SectionNotFound(section)
    return to_plain(document[section])


def _same(left: Any, right: Any) -> bool:
    """Structural equality that does not conflate `True` with `1`, or `1` with `1.0`.

    `True == 1` in Python, so a plain `==` would call a `true` turned into a `1`
    an unchanged value and leave the file saying the opposite of what the user
    asked for. `40 == 40.0` the same way, and there the *type* is what Calliope
    checks. Mappings compare without regard to key order, because the merge below
    keeps the file's order deliberately and a reordered payload is not an edit to
    anything.
    """
    if isinstance(left, bool) != isinstance(right, bool):
        return False
    # `40` and `40.0` are equal numbers and different YAML, and the difference is
    # load-bearing: Calliope requires a node's latitude and longitude to have
    # *matching* types, so `entities.harmonise_coordinates` turns an integer
    # longitude into a float on the way in. Calling the two the same value would
    # quietly undo that and put the model back in the state that stopped it
    # loading — `test_a_dragged_node_still_loads` is what catches it.
    if isinstance(left, int) != isinstance(right, int):
        return False
    if isinstance(left, dict) and isinstance(right, dict):
        return len(left) == len(right) and all(
            key in right and _same(value, right[key]) for key, value in left.items()
        )
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            _same(one, other) for one, other in zip(left, right)
        )
    if isinstance(left, dict | list) or isinstance(right, dict | list):
        return False
    return left == right


def _aliased(obj: Any, counts: dict[int, int] | None = None) -> set[int]:
    """The ids of containers a document reaches more than once.

    Two keys sharing a YAML anchor are the *same* `CommentedMap`, so merging
    into one of them mutates both — the user edits one technology and two
    change, and `to_plain` flattens the alias on the way out so nothing
    upstream can tell. Knowing which nodes are shared is what lets the merge
    give one of them a private copy instead.
    """
    counts = {} if counts is None else counts
    if isinstance(obj, CommentedMap | CommentedSeq):
        counts[id(obj)] = counts.get(id(obj), 0) + 1
        if counts[id(obj)] == 1:
            children = obj.values() if isinstance(obj, CommentedMap) else obj
            for child in children:
                _aliased(child, counts)
    return {key for key, count in counts.items() if count > 1}


def _detached(container: Any) -> Any:
    """A private copy of a container that was reached through an alias.

    The anchor goes with the original. Keeping it on the copy would emit the
    same anchor name twice, which is valid YAML that means something else.
    """
    clone = copy.deepcopy(container)
    clone.yaml_set_anchor(None)
    return clone


def _merge(
    existing: Any, new: Any, aliased: frozenset[int] | set[int] = frozenset()
) -> Any:
    """Applies `new` onto `existing` in place, disturbing as little as possible.

    Assigning the frontend's plain data straight over a section would discard
    every comment inside it, and would rewrite untouched scalars in ruamel's
    preferred style rather than the user's. Merging key by key means an edit to
    one field leaves its neighbours — and their comments — exactly as they were.
    """
    if isinstance(existing, CommentedMap | CommentedSeq):
        # An untouched subtree is handed back whole, never walked. That is what
        # keeps a YAML anchor intact across a save that did not touch it, and
        # it is also why a spelling-only difference costs nothing: `1e6` and
        # `1000000.0` compare equal, so the node is never reassigned.
        if _same(to_plain(existing), to_plain(new)):
            return existing
        if id(existing) in aliased:
            existing = _detached(existing)

    if isinstance(existing, CommentedMap) and isinstance(new, dict):
        for key in [key for key in existing if key not in new]:
            del existing[key]
        for key, value in new.items():
            existing[key] = (
                _merge(existing[key], value, aliased) if key in existing else value
            )
        return existing

    if isinstance(existing, CommentedSeq) and isinstance(new, list):
        # Item by item over the common prefix, then extend or truncate.
        # Replacing the whole sequence whenever the lengths differed dropped
        # every comment on the items already there — and adding one item to a
        # list is the ordinary case for an editor, not an exotic one.
        for index in range(min(len(existing), len(new))):
            existing[index] = _merge(existing[index], new[index], aliased)
        while len(existing) > len(new):
            del existing[len(existing) - 1]
        for value in new[len(existing) :]:
            existing.append(value)
        return existing

    # Kept for a client that still sends the old shape: `to_plain` used to map a
    # non-finite float to None, and a field the user never touched would then
    # come back as None and silently bound an unbounded parameter.
    if new is None and isinstance(existing, float) and not math.isfinite(existing):
        return existing

    # A scalar that survived the JSON hop is no longer ruamel's object, so
    # assigning it back rewrites the user's spelling: `bigM: 1e6` became
    # `1000000.0`, `0.10` became `0.1` and `0xFF` became `255`, in entries
    # nobody had touched. Same guard as `routes/overrides.py::_unchanged`.
    if _same(existing, new):
        return existing

    return new


def write_section(path: Path, section: str, data: Any) -> None:
    """Updates one top-level section, leaving the rest of the file intact.

    Raises:
        SectionNotFound: If the document is empty or lacks the section.
    """
    text = _read(path)
    yaml = _round_trip_yaml(text)
    document = yaml.load(text)
    if document is None or section not in document:
        raise SectionNotFound(section)

    document[section] = _merge(
        document[section], from_plain(data), _aliased(document[section])
    )
    buffer = io.StringIO()
    yaml.dump(document, buffer)
    write_text_atomic(path, buffer.getvalue())


def syntax_errors(path: Path, relative: str) -> list[dict]:
    """Parses a file and reports syntax errors with positions.

    Returns:
        A list with at most one error, shaped for the frontend's problem list.
    """
    try:
        YAML().load(_read(path))
    except YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        return [
            {
                "file": relative,
                "line": (mark.line + 1) if mark else None,
                "column": (mark.column + 1) if mark else None,
                "message": getattr(exc, "problem", None) or str(exc),
                "severity": "error",
            }
        ]
    except (OSError, ValueError) as exc:
        # `ValueError` is `UnicodeDecodeError`: a file with one stray non-UTF-8
        # byte is a file somebody is part-way through editing, and it must be
        # reported as a problem in that file rather than raised at whoever asked.
        return [
            {
                "file": relative,
                "line": None,
                "column": None,
                "message": str(exc),
                "severity": "error",
            }
        ]
    return []


def load_quietly(path: Path) -> Any:
    """Loads a document, returning None on any parse or read failure.

    Used by the structural readers (import graph, component tree, data tables),
    which walk every YAML file in a workspace and must not fail wholesale
    because one file is mid-edit and temporarily invalid.
    """
    try:
        return _round_trip_yaml().load(_read(path))
    except (YAMLError, OSError, ValueError):
        # `ValueError` covers `UnicodeDecodeError`, which is neither of the
        # other two and so used to escape a function documented as returning
        # None on *any* failure. One non-UTF-8 byte anywhere in a workspace
        # therefore 500ed the component tree, the import graph, `/geo/`,
        # `/schema/files/`, snapshotting, resolution and validation at once,
        # with nothing anywhere naming the file.
        return None
