"""Freezing a model definition, so a run can be reopened and understood later.

A run must be reopenable months afterwards and show the model *as it was written
when the run started*, not as it is now. Nothing else on disk does that: the
workspace is mutable, and `results.nc` carries only the fully resolved
configuration, not the user's YAML with its comments and file structure.

Captured deliberately rather than by copying the whole folder. A workspace may
contain notebooks, scratch `.nc` files and output directories that have nothing
to do with the model, and copying those on every run would make the history cost
gigabytes. On Calliope's own example models the deliberate set and the whole
folder are within a couple of percent of each other anyway, so precision costs
nothing here and bounds the pathological case.

Calliope names files in **three** different ways, and a snapshot missing any one
of them is not a model that can be built:

1. `import:` chains, which `imports.reachable_files` follows;
2. `data_tables[*].table`, which `data_tables.collect_data_tables` finds,
   including inside `overrides:`;
3. `config.init.math_paths`, which nothing else in this package looks at —
   `urban_scale` refers to `additional_math.yaml` this way, and it is invisible
   to the import graph.

If a run history ever grows large enough to matter, the fix is content-addressed
storage — `calliope-studio/blobs/{sha256}` with hardlinks into each snapshot — so that
an unchanged CSV costs nothing across runs. Deliberately not built yet.
"""

import shutil
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from calliope_studio.modeldef.data_tables import collect_data_tables
from calliope_studio.modeldef.imports import find_model_yaml, reachable_files
from calliope_studio.modeldef.paths import file_type, is_excluded
from calliope_studio.modeldef.yaml_io import load_quietly

#: Manifest format version, so that a future change can be detected rather than
#: guessed at from which keys happen to be present.
SNAPSHOT_VERSION = 1


@dataclass
class Collected:
    """What a model definition refers to, split by whether it can be frozen."""

    #: Workspace-relative paths, entry point first, deduplicated and ordered.
    files: list[str] = field(default_factory=list)
    #: References resolving outside the workspace, or missing. These cannot be
    #: frozen without rewriting the YAML that points at them, which would destroy
    #: the byte-fidelity that is the whole point of a snapshot.
    external: list[dict] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        """Whether the captured set is the whole model."""
        return not self.external


def _import_entries(document: Any) -> list[str]:
    """The raw `import:` list, however it was written.

    Calliope accepts a bare string as well as a list, so both are normalised.
    """
    imports = document.get("import") or [] if isinstance(document, dict) else []
    if not isinstance(imports, list):
        imports = [imports]
    return [str(entry) for entry in imports if entry]


def math_path_entries(document: Any) -> dict[str, str]:
    """Math files named in `config.init.math_paths`, keyed by their math *name*.

    These are *not* reachable through `import:`, so the import graph cannot see
    them. `urban_scale` refers to `additional_math.yaml` this way, and a snapshot
    missing it is not a model that builds.

    Public because it is the only implementation of this route in the package,
    and three callers need the same answer for different reasons: a snapshot must
    copy the file, `filekinds` must not validate it against the model-definition
    schema, and `mathdef` must say whether it is enabled — which is a question
    about the *key*, since `config.init.extra_math` names math by key and not by
    path. The keys used to be discarded here, so nothing could answer it.
    """
    config = document.get("config") if isinstance(document, dict) else None
    init = config.get("init") if isinstance(config, dict) else None
    paths = init.get("math_paths") if isinstance(init, dict) else None
    if not isinstance(paths, dict):
        return {}
    return {str(name): str(value) for name, value in paths.items()}


def math_paths(document: Any) -> list[str]:
    """Just the paths from `math_path_entries`, for callers that copy files."""
    return list(math_path_entries(document).values())


def resolve_math_path(root: Path, name: str) -> Path:
    """Where Calliope will look for a math file named in `math_paths`.

    **Relative to the workspace root, never to the file that declares it.**
    `prepare_model_definition` hands `initialise_math` the `definition_path` it
    was given — the entry-point `model.yaml`, which `find_model_yaml` only ever
    finds at the workspace root — and `relative_path` resolves against that. A
    `math_paths:` entry written inside an imported subfolder therefore means
    something different from every other relative path in that file.

    Both callers used to resolve against the declaring file's parent, which is
    right only for the common case of the entry being in the root `model.yaml`.
    Declared one level down, the file was classified `unknown` (so the editor
    validated math against the model-definition schema) and, worse, was left out
    of the run snapshot — which makes the frozen model unbuildable.
    """
    return (Path(root) / name).resolve()


def _data_files(config: dict) -> list[str]:
    """The CSV(s) one `data_tables:` entry points at.

    Calliope's schema declares `table` as a single path, but a list is accepted
    here rather than crashing the whole collection on one malformed entry, and
    the pre-0.7.0 `data` spelling is read as a fallback for the same reason: a
    snapshot of a broken model is still worth having.
    """
    value = config.get("table", config.get("data"))
    if not value:
        return []
    if isinstance(value, str):
        return [value]
    try:
        return [str(item) for item in value]
    except TypeError:
        return []


@dataclass(frozen=True)
class Reference:
    """One file naming another, and how Calliope will reach it."""

    #: The declaring file, absolute.
    source: Path
    #: Where the reference points. Joined but deliberately *not* resolved, so
    #: that `collect` can report it back as written.
    target: Path
    #: `"import"`, `"math"` or `"data_table"`.
    kind: str
    #: The reference exactly as the YAML spells it.
    raw: str


def walk_references(workspace: Path) -> list[Reference]:
    """Every file the model definition names, and which file names it.

    The three routes of this module's docstring, walked once. Two callers need
    the same answer for different reasons: a snapshot must copy each file, and
    the import graph must draw the edge — which is why the parent is carried
    rather than the flat set `collect` used to build on its own.

    The `import:` lists are re-read here rather than trusting `reachable_files`,
    which is the *closure inside the workspace*: `collect_imports` drops an
    import resolving outside it, or naming a file that is not there. Those have
    to be reported, not lost — a snapshot that quietly claimed to be complete
    would be solved from, and would fail a run that reading the live workspace
    would have completed.

    Order is per file, imports before math before data tables, over
    `reachable_files` — which is what makes a snapshot's file list stable.
    """
    root = Path(workspace).resolve()
    if find_model_yaml(root) is None:
        return []

    references: list[Reference] = []
    for path in reachable_files(root):
        document = load_quietly(path)
        if not isinstance(document, dict):
            continue
        for name in _import_entries(document):
            references.append(Reference(path, path.parent / name, "import", name))
        for name in math_paths(document):
            references.append(
                Reference(path, resolve_math_path(root, name), "math", name)
            )
        for _, config, directory in collect_data_tables(path):
            for name in _data_files(config):
                references.append(Reference(path, directory / name, "data_table", name))
    return references


def collect(workspace: Path) -> Collected:
    """Every file the model definition needs, as workspace-relative paths."""
    root = Path(workspace).resolve()
    collected = Collected()
    seen: set[str] = set()

    def add(target: Path, referenced_by: Path, kind: str) -> None:
        # `.resolve()` follows symlinks, so a link pointing out of the workspace
        # is classified external here rather than silently copied.
        resolved = target.resolve()
        outside = not resolved.is_relative_to(root)
        if outside or not resolved.is_file():
            collected.external.append(
                {
                    "reference": str(target),
                    "referenced_by": _relative(referenced_by, root),
                    "kind": kind,
                    "reason": "outside the workspace" if outside else "not found",
                }
            )
            return

        relative = resolved.relative_to(root).as_posix()
        # Guards against a pathological `import: calliope-studio/runs/x/snapshot/...`
        # making every snapshot contain the previous one.
        if is_excluded(Path(relative)) or relative in seen:
            return
        seen.add(relative)
        collected.files.append(relative)

    if find_model_yaml(root) is None:
        return collected

    for path in reachable_files(root):
        add(path, path, "import")

    # Entries resolving inside the workspace are already captured above and are
    # skipped here as duplicates; what this pass adds is the ones that are not.
    for reference in walk_references(root):
        add(reference.target, reference.source, reference.kind)

    return collected


def write_snapshot(workspace: Path, destination: Path) -> dict:
    """Copies the model definition into `destination` and describes the result.

    Args:
        workspace: Model definition folder to freeze.
        destination: Directory to create. The workspace-relative layout is
            mirrored inside it exactly, so that walking a file tree over it and
            handing it to `calliope.read_yaml` both behave as they do on the
            original.

    Returns:
        The manifest: what was captured, what could not be, and whether the
        snapshot is a complete, buildable model.
    """
    root = Path(workspace).resolve()
    destination = Path(destination)
    collected = collect(root)

    files = []
    for relative in collected.files:
        source = root / relative
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        # `copy2` rather than `copy`, so each file's own mtime survives and the
        # frozen tree can show when it was last edited. Never a hardlink: the
        # editor writes in place, which would silently rewrite history.
        shutil.copy2(source, target)
        files.append(
            {
                "path": relative,
                "type": file_type(source.name),
                "size": target.stat().st_size,
            }
        )

    return {
        "version": SNAPSHOT_VERSION,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "workspace": str(root),
        "complete": collected.complete,
        # The worker reads this. An incomplete snapshot is not a buildable model,
        # so solving from it would fail a run that would otherwise have
        # succeeded; honesty beats purity.
        "solve_from": "snapshot" if collected.complete else "workspace",
        "files": files,
        "external": collected.external,
        "total_bytes": sum(item["size"] for item in files),
    }


def _relative(path: Path, root: Path) -> str:
    """A snapshot-relative POSIX path, or the absolute one if it is outside.

    POSIX because `snapshot.json` is read back on whatever machine has the
    workspace, and the run history's whole premise is that a workspace can be
    copied or checked out. A manifest written on Windows with backslash-separated
    entries is not readable by the same code on macOS, and the failure is a run
    whose frozen tree silently lists nothing.

    The fallback keeps `str()`: a path outside the root is absolute and platform
    specific already, and there is no root to make it relative to.
    """
    try:
        return Path(path).resolve().relative_to(root).as_posix()
    except ValueError:
        return str(path)
