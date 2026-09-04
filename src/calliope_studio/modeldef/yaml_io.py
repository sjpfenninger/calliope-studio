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

import codecs
import copy
import io
import json
import math
import re
from collections.abc import Callable, Mapping
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


def _detect_indents(text: str) -> tuple[int, int, int]:
    """Infers how a document indents mappings and block sequences.

    ruamel emits with one global setting for each, but real files differ: some
    put a list's dash at the parent key's column, others indent it, and a model
    written with four-space mappings is not rare. Guessing wrong reflows every
    line in the file and shifts its trailing comments — a save that touched one
    field then diffs as the whole file, which is exactly the kind of spurious
    change that makes an editor untrustworthy. Mapping indent used to be fixed
    at two, so a four-space model was reformatted by its first structured save.

    Returns:
        `(mapping, sequence, offset)` for `YAML.indent`, defaulting to ruamel's own.
    """
    mapping: int | None = None
    sequence: tuple[int, int] | None = None
    key_indent: int | None = None
    for line in text.splitlines():
        item = _SEQUENCE_ITEM.match(line)
        if item and key_indent is not None and sequence is None:
            offset = len(item.group("indent")) - key_indent
            sequence = (offset + 2, offset) if offset >= 0 else (4, 2)
        key = _MAPPING_KEY.match(line)
        if key:
            indent = len(key.group("indent"))
            if mapping is None and key_indent is not None and indent > key_indent:
                mapping = indent - key_indent
            key_indent = indent
        if mapping is not None and sequence is not None:
            break
    return (mapping or 2, *(sequence or (4, 2)))


def _has_explicit_start(text: str) -> bool:
    """Whether the document opens with a bare `---` before any content."""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped[0] in "#%":
            continue
        return stripped == "---" or stripped.startswith("--- ")
    return False


def _round_trip_yaml(text: str | None = None) -> YAML:
    yaml = YAML(typ="rt")
    yaml.preserve_quotes = True
    # ruamel wraps scalars at 80 columns by default, which folds long math
    # expressions and descriptions across lines the user never edited. Wrapping
    # is semantically harmless but makes for an alarming diff.
    yaml.width = 4096
    if text is not None:
        mapping, sequence, offset = _detect_indents(text)
        yaml.indent(mapping=mapping, sequence=sequence, offset=offset)
        # A leading `---` is dropped by a plain load-and-dump; kept because the
        # raw file route preserves it and the two save paths must agree.
        yaml.explicit_start = _has_explicit_start(text)
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


def _same(existing: Any, new: Any) -> bool:
    """Whether what came back over the wire is what went out.

    Structural equality that does not conflate `True` with `1`: `True == 1` in
    Python, so a plain `==` would call a `true` turned into a `1` an unchanged
    value and leave the file saying the opposite of what the user asked for.
    Mappings compare without regard to key order, because the merge below keeps
    the file's order deliberately and a reordered payload is not an edit to
    anything.

    The one asymmetry is deliberate. `existing` is what the file says and `new`
    is what JSON delivered, and JSON — JavaScript's, which is what every
    structured editor sends — cannot say "the float 29": `29.0` serialises as
    `29`. So an integer arriving where the file holds an equal integral float is
    not an edit, and the file's spelling stays. Without this a no-op save of
    Calliope's own `urban_scale` rewrote `29.0` as `29` and `[0.0035, 0.0]` as
    `[0.0035, 0]` in entries nobody had opened. The other direction — a float
    arriving where the file holds an int — *is* an edit: `40` and `40.0` are
    different YAML, and Calliope requires a node's latitude and longitude to
    have matching types, which is why the caller harmonises a node's pair
    *after* this merge (`entities.harmonise_coordinates`), when it can see
    which spellings survived.
    """
    if isinstance(existing, bool) != isinstance(new, bool):
        return False
    if (
        isinstance(existing, float)
        and isinstance(new, int)
        and not isinstance(new, bool)
        and existing == new
    ):
        return True
    if isinstance(existing, int) != isinstance(new, int):
        return False
    if isinstance(existing, dict) and isinstance(new, dict):
        return len(existing) == len(new) and all(
            key in new and _same(value, new[key]) for key, value in existing.items()
        )
    if isinstance(existing, list) and isinstance(new, list):
        return len(existing) == len(new) and all(
            _same(one, other) for one, other in zip(existing, new)
        )
    if isinstance(existing, dict | list) or isinstance(new, dict | list):
        return False
    return existing == new


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


def _key_text(key: Any) -> str:
    """How a mapping key is spelled once it has been through JSON."""
    if isinstance(key, str):
        return key
    try:
        return json.dumps(key)
    except TypeError:
        return str(key)


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
        # JSON has only string keys, so an integer, boolean or null key comes
        # back spelled out: `nodes: {1: …}` arrived as `{"1": …}`, the merge
        # deleted the integer key and appended a quoted one — and the comment on
        # the original line went with it. Matching by spelling keeps the key.
        by_text = {_key_text(key): key for key in existing}
        new = {
            by_text.get(key, key) if isinstance(key, str) else key: value
            for key, value in new.items()
        }
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


def _rename_keys(section: CommentedMap, renames: Mapping[str, str]) -> None:
    """Renames keys of `section` in place, each keeping its position and node.

    A rename that reached `_merge` as a delete and an add lost three things at
    once: the entry's place in the file, every comment and scalar spelling
    inside its block (an unknown key is rebuilt from plain JSON), and the
    comment above the *next* key — which ruamel hangs on this entry's last
    scalar, so only keeping the position keeps it. Reusing the node at the
    same index keeps all three. The client says which keys were renamed rather
    than the server guessing: a deletion and an addition at one position is
    also what a genuine delete-and-add looks like, and a guess would carry the
    wrong comments onto the new entry.

    `renames` maps the new name to the old, as JSON spells it — an integer key
    arrives as its text and is matched the way `_merge` matches it. Two phases,
    because `CommentedMap.insert` silently replaces an existing key of the same
    name, so a swap applied one rename at a time loses half of itself.

    Raises:
        ValueError: If an old name is not in the section, or a new one is
            already there and not itself being renamed away. A name freed by a
            deletion in the same save counts as taken: from here a present key
            and a present payload entry look the same whether the user deleted
            one and renamed another onto it or renamed onto one still in use.
    """
    by_text = {_key_text(key): key for key in section}
    keys = list(section)
    moves: list[tuple[int, Any, str]] = []
    for new, old_text in renames.items():
        old = by_text.get(old_text, old_text)
        if old not in section:
            raise ValueError(f"Cannot rename '{old_text}': it is not in this section.")
        if _key_text(old) == new:
            continue
        moves.append((keys.index(old), old, new))
    renamed_away = {old for _, old, _ in moves}
    for _, _, new in moves:
        if new in section and new not in renamed_away:
            raise ValueError(f"Cannot rename to '{new}': it already exists.")

    # Everything out before anything back in: `insert` deletes an existing key
    # of the same name, which in a swap is the other half. `__delitem__` drops
    # the key's own comment entry with it, so that is lifted first.
    taken = []
    for pos, old, new in sorted(moves, key=lambda move: move[0]):
        taken.append((pos, old, new, section[old], section.ca.items.pop(old, None)))
    for _, old, _ in moves:
        del section[old]
    for pos, old, new, node, comment in taken:
        section.insert(pos, new, node)
        if comment is None:
            continue
        eol = comment[2]
        if eol is not None:
            # A trailing comment is emitted at the column it was read at, so a
            # shorter name would push it right by the letters it lost.
            shift = len(str(new)) - len(str(old))
            eol.start_mark.column = max(eol.start_mark.column + shift, 0)
        section.ca.items[new] = comment


def write_section(
    path: Path,
    section: str,
    data: Any,
    *,
    renames: Mapping[str, str] | None = None,
    after_merge: Callable[[Any], Any] | None = None,
) -> None:
    """Updates one top-level section, leaving the rest of the file intact.

    `renames` maps a new key of the section to the old key it replaces, so a
    renamed entry keeps its place, its comments and its spellings rather than
    being deleted and appended; see `_rename_keys`. It is applied before the
    merge, which then sees the new key as one it already has.

    `after_merge` sees the merged section — ruamel's objects, with every
    untouched scalar still spelled as the file spells it — before it is written.
    It exists for a rule that depends on which spellings survived: a node's
    coordinate pair has to end up one type, and whether the merge kept the
    file's `-2.0` against an incoming `-2` is not something the caller can know
    from the payload alone.

    Raises:
        SectionNotFound: If the document is empty or lacks the section.
        ValueError: If a rename names a key that is not there, or one that is.
    """
    # Bytes, not `read_text`: universal newlines would fold a CRLF file to LF
    # here while the raw file route preserves it, so which endpoint last saved
    # a file decided its line endings. A BOM the same way. Both are put back.
    raw = Path(path).read_bytes()
    bom = raw.startswith(codecs.BOM_UTF8)
    text = raw[len(codecs.BOM_UTF8) :].decode("utf-8") if bom else raw.decode("utf-8")
    crlf = "\r\n" in text
    if crlf:
        text = text.replace("\r\n", "\n")

    yaml = _round_trip_yaml(text)
    document = yaml.load(text)
    if document is None or section not in document:
        raise SectionNotFound(section)

    target = document[section]
    if renames:
        if not isinstance(target, CommentedMap):
            raise ValueError(f"Cannot rename keys: '{section}' is not a mapping.")
        _rename_keys(target, renames)
    document[section] = _merge(target, from_plain(data), _aliased(target))
    if after_merge is not None:
        after_merge(document[section])
    buffer = io.StringIO()
    yaml.dump(document, buffer)
    out = buffer.getvalue()
    if crlf:
        out = out.replace("\n", "\r\n")
    if bom:
        out = "﻿" + out
    write_text_atomic(path, out)


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
