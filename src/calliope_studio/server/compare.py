"""Two versions of one model, and what differs between them.

A *side* is a source of a model definition: the workspace as it is now, or the
tree a run froze before it solved. Everything below this module sees only
`Side` objects, so adding a source — a git commit, in the version-tracking work
this was shaped for — means a new arm in `parse_ref` and `side_for`, not a new
view.

Composed here rather than in a domain layer for the same reason `resolution.py`
is: answering takes `modeldef` to know which files a model refers to, `runs` to
find a frozen tree, `results` to load what Calliope made of it, and `server` is
the only layer allowed to put those together.

**A side is a folder *and* a scenario.** One definition means different things
under different scenarios, so comparing a run against the working tree resolves
the working tree under *that run's* scenario — otherwise the diff is dominated
by what the scenario does and says nothing about what the user changed. The
workspace side can name any scenario, which is what makes "what does this
scenario do to the base model?" the same view with the same folder on both
sides.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from calliope_studio.modeldef import snapshot
from calliope_studio.modeldef.imports import scenario_names
from calliope_studio.modeldef.paths import content_revision, file_type, walk_files
from calliope_studio.results import store as results_store
from calliope_studio.results.store import LoadedModel
from calliope_studio.runs import protocol
from calliope_studio.runs.manager import RunManager, RunRecord
from calliope_studio.server import deps
from calliope_studio.server.resolution import (
    RUN_WORKSPACE_PREFIX,
    SOURCE_RESOLVED,
    Resolution,
    Resolver,
    Variant,
)
from calliope_studio.server.storage import Workspace

#: Runs whose `results.nc` is finished and safe to read.
TERMINAL_STATUSES = ("success", "infeasible", "failed", "cancelled")

#: What a side reports when there is no model to be had from it at all.
SOURCE_UNAVAILABLE = "unavailable"

#: Shown first in the file list: it is where anybody reading a model starts.
ENTRY_POINT = "model.yaml"


class BadRef(ValueError):
    """Raised when a side reference is not one this version understands."""


class SideUnavailable(ValueError):
    """Raised when a reference names something that cannot be compared."""


class SideNotFound(SideUnavailable):
    """Raised when a reference names something that is not here.

    Separate from its parent so the route does not have to decide a status code
    by reading the message — a run pruned since the URL was bookmarked is a 404,
    while a run that exists but froze nothing is a 400, and the two are not
    interchangeable to anybody debugging a link that stopped working.
    """


@dataclass(frozen=True)
class Ref:
    """Which version of the model a side is.

    Spelled `workspace`, `workspace@{scenario}` or `run.{id}`. The separators
    are deliberate: a tab id splits on `:` (`web/src/lib/tabId.ts`), so neither
    part of a reference may contain one, and a scenario legitimately contains
    commas because Calliope's `scenario=` also takes a joined list of override
    names.
    """

    kind: str
    run_id: str | None = None
    scenario: str | None = None


def parse_ref(text: str) -> Ref:
    """Reads a reference, or says why it is not one.

    Rejects rather than guesses: a malformed reference in a URL is a bookmark
    from a future version or a typo, and both are better as an error than as a
    comparison of something the user did not ask for.
    """
    if not text:
        raise BadRef("A comparison needs two sides.")
    head, _, scenario = text.partition("@")
    kind, _, run_id = head.partition(".")

    if kind == "workspace":
        if run_id:
            raise BadRef(f"Not a reference: {text!r}")
        return Ref("workspace", scenario=scenario or None)
    if kind == "run":
        if not run_id:
            raise BadRef("A run reference needs a run id.")
        if scenario:
            # A run solved what it solved. Offering to re-read its frozen files
            # under a different scenario would present something that never ran
            # as though it had.
            raise BadRef("A run is already a scenario; it cannot take another.")
        return Ref("run", run_id=run_id)
    raise BadRef(f"Not a reference: {text!r}")


def format_ref(ref: Ref) -> str:
    """The spelling `parse_ref` reads. The twin of `lib/compareRef.ts`."""
    if ref.kind == "run":
        return f"run.{ref.run_id}"
    return f"workspace@{ref.scenario}" if ref.scenario else "workspace"


@dataclass
class Side:
    """One version of a model definition, ready to be read."""

    ref: Ref
    label: str
    root: Path
    files: list[dict]
    variant: Variant
    run: RunRecord | None = None
    snapshot_complete: bool | None = None
    #: Whether the scenario this side names is one the model defines. False is
    #: reported rather than refused: a scenario renamed since a run was solved
    #: is exactly the state somebody comparing that run is in, and the files
    #: still compare perfectly well.
    scenario_known: bool = True
    model_source: dict = field(default_factory=dict)

    @property
    def kind(self) -> str:
        return self.ref.kind

    def descriptor(self) -> dict:
        payload: dict[str, Any] = {
            "ref": format_ref(self.ref),
            "kind": self.kind,
            "label": self.label,
            "scenario": self.ref.scenario if self.kind == "workspace" else None,
            "scenario_known": self.scenario_known,
            "model": self.model_source,
        }
        if self.run is not None:
            payload.update(
                run_id=self.run.id,
                created_at=self.run.created_at,
                status=self.run.status,
                scenario=self.run.scenario,
                override_dict=self.run.override_dict,
                snapshot_complete=self.snapshot_complete,
            )
        return payload


def side_for(ref: Ref, workspace: Workspace, runs: RunManager) -> Side:
    """The side a reference names, or `SideUnavailable` saying why not."""
    if ref.kind == "workspace":
        known = not ref.scenario or ref.scenario in _scenario_names(workspace.path)
        return Side(
            ref=ref,
            label=workspace.name,
            root=workspace.path,
            files=_workspace_files(workspace.path),
            variant=(ref.scenario or None, {}),
            scenario_known=known,
        )

    record = _record(ref.run_id, workspace, runs)
    if not record.has_snapshot:
        raise SideUnavailable(
            "This run did not freeze a copy of the model, so there is "
            "nothing to compare."
        )
    root = runs.run_dir(record.id) / protocol.SNAPSHOT_DIR
    return Side(
        ref=ref,
        label=record.label or record.id[:8],
        root=root,
        files=_snapshot_files(runs.run_dir(record.id), root),
        variant=(record.scenario, dict(record.override_dict or {})),
        run=record,
        snapshot_complete=record.snapshot_complete,
    )


def _record(run_id: str, workspace: Workspace, runs: RunManager) -> RunRecord:
    """The run, if it belongs to this model.

    `RunManager.run_dir` searches every registered workspace, so a run id alone
    reaches across models. A comparison is scoped to one model — its URL names
    the version, and the workspace side is that version — so a run from
    somewhere else is not found here rather than half-compared.
    """
    try:
        record = runs.get(run_id, with_size=False)
    except KeyError:
        raise SideNotFound(f"Run {run_id} was not found.") from None
    if record.workspace and Path(record.workspace).resolve() != workspace.path:
        # Not "forbidden": as far as this model is concerned the run does not
        # exist, and saying otherwise would confirm what another model contains.
        raise SideNotFound(f"Run {run_id} was not found.")
    return record


def _scenario_names(root: Path) -> set[str]:
    try:
        return scenario_names(root)
    except Exception:
        # A model too broken to enumerate its scenarios is a model being
        # edited. Nothing is claimed about the name; the resolve will say.
        return set()


def _workspace_files(root: Path) -> list[dict]:
    """Every file the model *refers to*, which is not every file in the folder.

    A snapshot holds what the model reaches — imports, data-table CSVs and the
    math files the import graph cannot see — so comparing it against a plain
    directory listing would report every scratch file, note and half-finished
    experiment beside the model as newly added.
    """
    entries = []
    for relative in snapshot.collect(root).files:
        path = root / relative
        try:
            size = path.stat().st_size
        except OSError:
            continue
        entries.append(
            {"path": relative, "type": file_type(Path(relative).name), "size": size}
        )
    return entries


def _snapshot_files(run_dir: Path, root: Path) -> list[dict]:
    manifest = protocol.read_snapshot_manifest(run_dir)
    listed = manifest.get("files") if isinstance(manifest, dict) else None
    if listed:
        return [dict(entry) for entry in listed]
    # A snapshot written before manifests carried a file list, or one whose
    # manifest has gone: the tree itself is still the answer.
    return [entry for entry in walk_files(root) if entry.get("type") != "directory"]


# -- files --------------------------------------------------------------------


def files_diff(a: Side, b: Side) -> list[dict]:
    """Every file either side refers to, and how it differs.

    Content is compared by digest rather than by size or mtime: a snapshot is a
    `shutil.copy2`, so mtimes match a file that has since been rewritten, and
    an edit that keeps the length is exactly the edit somebody makes to a number.
    """
    by_path: dict[str, dict] = {}
    for side, name in ((a, "a"), (b, "b")):
        for entry in side.files:
            path = str(entry["path"])
            row = by_path.setdefault(
                path, {"path": path, "type": entry.get("type", "other")}
            )
            row[name] = {"size": entry.get("size")}

    rows = []
    for path, row in by_path.items():
        left = _digest(a.root / path) if row.get("a") else None
        right = _digest(b.root / path) if row.get("b") else None
        if row.get("a"):
            row["a"]["binary"] = deps.is_binary(a.root / path)
        if row.get("b"):
            row["b"]["binary"] = deps.is_binary(b.root / path)
        row.setdefault("a", None)
        row.setdefault("b", None)
        if left is None and right is None:
            # Listed by a manifest but no longer on disk on either side. Nothing
            # true can be said about it, so nothing is.
            continue
        if left is None:
            row["status"] = "added"
        elif right is None:
            row["status"] = "removed"
        else:
            row["status"] = "unchanged" if left == right else "modified"
        rows.append(row)

    rows.sort(key=lambda row: (row["path"] != ENTRY_POINT, row["path"]))
    return rows


def _digest(path: Path) -> str | None:
    try:
        return content_revision(path)
    except OSError:
        return None


def file_pair(a: Side, b: Side, relative: str) -> dict:
    """One file as each side has it, for a diff editor to render.

    Two whole texts rather than a patch: the frontend renders with Monaco's
    diff editor, which computes its own. A side that does not have the file
    gets `None`, which is what makes an addition and a deletion renderable
    without a second shape.
    """
    left = deps.resolve_within(a.root, relative)
    right = deps.resolve_within(b.root, relative)
    if not left.is_file() and not right.is_file():
        # Neither side has it. Distinct from an addition or a deletion, where
        # one side legitimately has nothing: this path is in no version of the
        # model, so there is nothing to render and nothing true to say.
        raise SideNotFound(f"{relative} is in neither version.")
    binary = (left.is_file() and deps.is_binary(left)) or (
        right.is_file() and deps.is_binary(right)
    )
    payload: dict[str, Any] = {"path": relative, "binary": binary}
    for path, name in ((left, "a"), (right, "b")):
        if binary or not path.is_file():
            payload[name] = None
            continue
        text, lossy = deps.decode_text(path)
        payload[name] = {"content": text, "lossy": lossy}
    return payload


# -- meaning ------------------------------------------------------------------


def model_for(
    side: Side, workspace: Workspace, resolver: Resolver
) -> LoadedModel | None:
    """What Calliope made of this side, if anything, recording how it was got.

    Three routes, and they are the same artefact by design: a solved
    `results.nc` and a resolved `resolved.nc` differ only in whether `results`
    is empty, so the comparison never has to know which one it was handed.

    A finished run has already been read by Calliope, so its own file answers.
    A run that failed, was cancelled or only built has no results — and its
    frozen tree is an ordinary model folder, so it resolves like any other, as a
    workspace that happens to be immutable. That is what makes a run comparable
    even when it never produced a number.
    """
    if side.run is not None:
        results_file = _results_file(side)
        if results_file is not None:
            side.model_source = {"source": "resolved"}
            try:
                return results_store.load(results_file).model
            except Exception as caught:
                side.model_source = {
                    "source": SOURCE_UNAVAILABLE,
                    "reason": f"This run's results could not be read: {caught}",
                }
                return None
        if side.snapshot_complete is False:
            side.model_source = {
                "source": SOURCE_UNAVAILABLE,
                "reason": (
                    "This run produced no results, and the model it froze refers "
                    "outside its own folder, so it cannot be read on its own."
                ),
            }
            return None

    resolution = resolver.get(_as_workspace(side, workspace), variant=side.variant)
    side.model_source = _model_source(resolution)
    # **A stale reading is not an answer here**, which is where a comparison
    # parts company with the map. `/geo/` shows the last resolution that made
    # sense while a rebuild runs, because a map of the previous save is more use
    # than no map and the banner says so. A diff cannot be labelled that way:
    # its every number would need the caveat, and the one case that matters —
    # the user has just edited something and wants to see what — is exactly when
    # the stale side still holds the *old* file and reports no differences at
    # all. Observed, not theorised: an edited `flow_cap_max` came back "these
    # two versions are identical".
    return resolution.model if resolution.source == SOURCE_RESOLVED else None


def _results_file(side: Side) -> Path | None:
    if side.run is None or not side.run.has_results:
        return None
    if side.run.status not in TERMINAL_STATUSES:
        return None
    candidate = side.root.parent / protocol.RESULTS_FILE
    return candidate if candidate.is_file() else None


def _as_workspace(side: Side, workspace: Workspace) -> Workspace:
    """The side, as something the resolver can be asked about.

    A run's snapshot is a model folder in every respect the resolver cares
    about — `find_model_yaml` finds its entry point and `fingerprint` reads its
    files — so it is handed over as a synthetic workspace rather than given a
    resolution mechanism of its own. Its id is namespaced so it can never
    collide with a real workspace's, and its fingerprint never changes, so the
    entry is built once and then simply hit.
    """
    if side.run is None:
        return workspace
    return Workspace(
        id=f"{RUN_WORKSPACE_PREFIX}{side.run.id}",
        path=side.root,
        name=side.label,
        opened_at=datetime.now(timezone.utc),
    )


def _model_source(resolution: Resolution) -> dict:
    """How the side was read, in the words the client shows.

    Anything short of a current reading is `unavailable` — see `model_for` for
    why a stale one is refused rather than shown. `resolve_task` survives, so a
    client can tell "still being read" from "cannot be read" and poll rather
    than give up; `reason` is only set when Calliope has said nothing itself,
    since its own message is always the more useful of the two.
    """
    payload = resolution.as_dict()
    if resolution.source != SOURCE_RESOLVED:
        payload["source"] = SOURCE_UNAVAILABLE
        if not payload.get("resolve_task") and not payload.get("resolve_error"):
            payload.setdefault(
                "reason",
                "Calliope has not been able to read this version of the model.",
            )
    return payload
