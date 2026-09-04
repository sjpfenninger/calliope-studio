"""Which math a model declares, and which of it Calliope will actually apply.

This is the **structural** half of math, in the sense the package docstring means:
what the files say. It answers from the YAML alone, so it keeps working on a model
that does not build — which is the state of one being edited, and the state a user
is in precisely when they are wiring up a math file for the first time.

The *meaning* half — what a constraint says, rendered as notation — is Calliope's
and is asked for in a subprocess (`runs.mathdoc`). Nothing here parses an
expression or a `where` string, and nothing here should ever start to.

Two things make this worth a module rather than a few lines in `imports`:

- **Declaring a math file and enabling it are different acts.** `math_paths` maps
  a *name* to a path; `extra_math` lists the names to apply. A file registered but
  left out of `extra_math` is read by nobody and reported by nothing — Calliope
  does not warn, because from its point of view you simply did not ask for it.
  That is the single easiest way to write custom math that silently does nothing,
  so the tree says so.
- **A user math file may replace a built-in one.** `initialise_math` keys the
  whole pool by name, so `math_paths: {base: …}` substitutes the user's file for
  Calliope's entire base math and only logs a warning. It is a legitimate thing to
  do and a catastrophic thing to do by accident.
"""

from functools import lru_cache
from pathlib import Path
from typing import Any

from calliope_studio.modeldef.imports import declaring_line, reachable_files
from calliope_studio.modeldef.snapshot import math_path_entries, resolve_math_path
from calliope_studio.modeldef.yaml_io import load_quietly

#: A math source Calliope ships. Applied by name, never declared by the user.
BUILTIN = "builtin"

#: A math source the model declares in `config.init.math_paths`.
USER = "user"

#: Named in `config.init.extra_math` but neither built in nor declared. Calliope
#: raises `ModelError: Requested math '…' was not initialised.` on read, so this
#: is a broken model — reported here rather than costing a subprocess to discover.
UNKNOWN = "unknown"

#: `config.init.math_paths` or `extra_math` written in a shape Calliope's schema
#: refuses: a list where a mapping is wanted, a bare name where a list is. Both
#: are the ordinary shape of the typo, and a module whose job is to explain why
#: math is not being applied has to say so rather than read `extra_math: mine`
#: as the four names `m`, `i`, `n`, `e` — which is what iterating it did.
MALFORMED = "malformed"


@lru_cache(maxsize=1)
def builtin_math_names() -> tuple[str, ...]:
    """The math Calliope ships, by the name `extra_math` would call it.

    Read from the package directory rather than listed here, because that is what
    `initialise_math` itself does — it stems every file in `calliope/math/` into
    the pool — so a math file added by a future Calliope is picked up without an
    edit. `modeldef.schema.MATH_SOURCES` used to be a hand-kept copy of this.

    `base` first and the rest sorted, because `schema` merges in this order and
    takes the first definition of a name: base is the authoritative one, and the
    mode files mostly re-declare a component to add bounds. Alphabetical order
    happens to put `base` first today, which is not a thing to rely on.
    """
    from calliope.preprocess.model_math import MATH_FILE_DIR

    names = sorted(path.stem for path in MATH_FILE_DIR.iterdir())
    return tuple(["base"] * ("base" in names) + [n for n in names if n != "base"])


@lru_cache(maxsize=1)
def component_groups() -> tuple[str, ...]:
    """The top-level keys a math file may contain, in Calliope's own order."""
    from calliope.schemas.math_schema import CalliopeBuildMath

    return tuple(CalliopeBuildMath.model_fields)


def math_sources(base: Path) -> list[dict]:
    """Every math source in play, in the order Calliope applies them.

    `base` → `mode` → each name in `extra_math`, which is `get_math_priority`'s
    order and therefore the order in which later definitions overwrite earlier
    ones. Anything declared but not enabled follows, marked `applied: false`.

    Args:
        base: The model definition folder.

    Returns:
        One entry per source. `kind` is `builtin`, `user` or `unknown`; `applied`
        says whether Calliope will read it; `shadows_builtin` says the user's file
        has taken a built-in name; `missing` says the declared path is not there.
    """
    root = Path(base).resolve()
    declared = _declared_math(root)
    init = _init_config(root)
    builtin = builtin_math_names()

    order = ["base"]
    mode = init.get("mode")
    if mode and mode != "base":
        order.append(str(mode))
    extra = init.get("extra_math") or []
    sources: list[dict] = []
    if isinstance(extra, list):
        order += [str(name) for name in extra]
    else:
        sources.append(
            _malformed(
                "extra_math",
                f"`extra_math` must be a list of names; it is written as "
                f"`{extra}`, so nothing it names is applied.",
            )
        )
    for problem in _malformed_math_paths(root):
        sources.append(problem)

    seen: set[str] = set()
    for name in order:
        if name in seen:
            continue
        seen.add(name)
        sources.append(_source(root, name, declared, builtin, applied=True))
    for name in declared:
        if name in seen:
            continue
        seen.add(name)
        sources.append(_source(root, name, declared, builtin, applied=False))
    return sources


def math_components(base: Path) -> dict[str, dict[str, dict]]:
    """Where each component declared by a user math file is written.

    The rendered math knows which *source* a component came from, because
    Calliope keeps the named blocks; it does not know which line of which file,
    because by then it is a parsed pydantic model. This supplies that, so the
    Math tab can offer "go to where this is declared" for a component the user
    wrote — the same affordance `SourceLink` gives an inherited value.

    Returns:
        `{group: {component name: {source, file, line}}}`, later sources winning,
        which matches the precedence Calliope applies them with.
    """
    root = Path(base).resolve()
    groups = component_groups()
    found: dict[str, dict[str, dict]] = {}

    for source in math_sources(root):
        if source["kind"] != USER or source.get("missing"):
            continue
        document = load_quietly(root / source["path"])
        if not isinstance(document, dict):
            continue
        for group in groups:
            block = document.get(group)
            if not isinstance(block, dict):
                continue
            for name in block:
                entry = {"source": source["name"], "file": source["path"]}
                line = declaring_line(block, name)
                if line is not None:
                    entry["line"] = line
                found.setdefault(group, {})[str(name)] = entry

    return found


def _source(
    root: Path,
    name: str,
    declared: dict[str, dict],
    builtin: tuple[str, ...],
    *,
    applied: bool,
) -> dict:
    """One entry of `math_sources`."""
    entry: dict[str, Any] = {"name": name, "applied": applied}

    if name in declared:
        registration = declared[name]
        target = resolve_math_path(root, registration["path"])
        exists = target.is_file() and target.is_relative_to(root)
        entry["kind"] = USER
        entry["path"] = (
            target.relative_to(root).as_posix() if exists else registration["path"]
        )
        entry["file"] = registration["file"]
        if registration.get("line") is not None:
            entry["line"] = registration["line"]
        if not exists:
            entry["missing"] = True
        if name in builtin:
            entry["shadows_builtin"] = True
        entry["counts"] = _counts(target) if exists else {}
        return entry

    entry["kind"] = BUILTIN if name in builtin else UNKNOWN
    return entry


def _malformed(name: str, problem: str) -> dict:
    """A source entry that exists only to say a declaration is unreadable."""
    return {"name": name, "kind": MALFORMED, "applied": False, "problem": problem}


def _malformed_math_paths(root: Path) -> list[dict]:
    """One entry per file whose `math_paths` is not a mapping of name to path.

    `math_path_entries` answers `{}` for the shape, which every other caller
    wants — a snapshot cannot copy what it cannot read — but here it would mean
    a file the user wrote is simply not listed, which is the silence this
    module exists to break.
    """
    problems = []
    for path in reachable_files(root):
        document = load_quietly(path)
        block = _math_paths_block(document)
        if block is None or isinstance(block, dict):
            continue
        problems.append(
            _malformed(
                "math_paths",
                f"`math_paths` in {path.relative_to(root).as_posix()} must map "
                f"each math name to its file; it is written as `{block}`, so "
                "no math file it names is read.",
            )
        )
    return problems


def _counts(path: Path) -> dict[str, int]:
    """How many components of each kind a math file defines.

    Shown as a badge, so a source says something before it is opened — and so an
    enabled file that turns out to define nothing is visible as such.
    """
    document = load_quietly(path)
    if not isinstance(document, dict):
        return {}
    return {
        group: len(document[group])
        for group in component_groups()
        if isinstance(document.get(group), dict) and document[group]
    }


def _declared_math(root: Path) -> dict[str, dict]:
    """Every `config.init.math_paths` registration, with where it is written.

    Read per file rather than from the assembled definition, for the same reason
    `component_tree` is: assembly resolves away the file a key came from, and the
    file and line are the whole point of the entry. First declaration of a name
    wins, as everywhere else in this package.
    """
    declared: dict[str, dict] = {}
    for path in reachable_files(root):
        document = load_quietly(path)
        if not isinstance(document, dict):
            continue
        entries = math_path_entries(document)
        if not entries:
            continue
        block = _math_paths_block(document)
        for name, value in entries.items():
            if name in declared:
                continue
            registration = {
                "path": value,
                "file": path.relative_to(root).as_posix(),
                "line": declaring_line(block, name),
            }
            declared[name] = registration
    return declared


def _math_paths_block(document: Any) -> Any:
    """The raw `math_paths` mapping, still carrying ruamel's key positions."""
    config = document.get("config") if isinstance(document, dict) else None
    init = config.get("init") if isinstance(config, dict) else None
    return init.get("math_paths") if isinstance(init, dict) else None


def _init_config(root: Path) -> dict:
    """`config.init` as the whole model means it, however it is spread out.

    `mode` and `extra_math` decide which math is applied and are ordinary config,
    so an imported file may set them — `merged_section` is the assembled answer.
    It falls back to a per-file merge on a model that does not assemble, which is
    exactly when this is still expected to answer.
    """
    from calliope_studio.modeldef.entities import merged_section

    config = merged_section(root, "config")
    init = config.get("init") if isinstance(config, dict) else None
    return init if isinstance(init, dict) else {}
