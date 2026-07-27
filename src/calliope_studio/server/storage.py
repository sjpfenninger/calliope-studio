"""Where model definitions and run outputs live.

This is the local side of the storage seam. A *workspace* is simply a folder on
disk containing a Calliope model definition — the folder the user opened. There
is no database: a registry file records which folders have been opened, and run
metadata lives beside the model it came from.

A hosted deployment would provide a different implementation of the same
interface, backed by per-user server-managed directories.
"""

import atexit
import dataclasses
import hashlib
import json
import os
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator

import platformdirs

from calliope_studio.runs import protocol

#: Directory created inside a workspace to hold run outputs.
#:
#: Deliberately *not* hidden. Results are the valuable output of the whole
#: application, and a user who cannot see where they are cannot open one in
#: another tool, share them, or tell what their history is costing them. The
#: previous `.calligraph` also appeared merely from opening a model, so a folder
#: gained a hidden directory before the user had done anything at all.
WORKSPACE_DATA_DIR = "calliope-studio"

#: Earlier names, migrated on open, oldest first. Kept as constants because
#: `modeldef.paths.EXCLUDED_NAMES` still hides them, so a workspace that somehow
#: escapes migration does not suddenly show run artefacts in its file tree.
#: `.calligraph` was the hidden name and came first; `calligraph` was the
#: visible directory under the project's previous name.
LEGACY_WORKSPACE_DATA_DIRS = (".calligraph", "calligraph")

#: Written into the data directory the first time anything is put there, so that
#: a model kept under version control does not sprout untracked files. Ignores
#: itself: nothing in this directory is part of the model definition.
GITIGNORE_CONTENTS = """\
# Calliope Studio writes run outputs here. Everything in this directory is
# derived from the model definition and can be deleted freely, including this
# file.
*
"""

#: How many runs to keep per workspace before the oldest finished ones are
#: removed. A run now costs its results plus a frozen copy of the model
#: definition, so an unbounded history is measured in gigabytes.
DEFAULT_RUN_RETENTION = 20

#: How many finished validation attempts to keep in the temporary root. Small:
#: a validation has no artefact worth keeping, and every keystroke-triggered
#: deep validation used to leave a permanent directory behind.
VALIDATION_RETENTION = 3

#: Overrides where the registry is kept. Tests set this so that they cannot
#: write into the developer's real state directory, and it is a useful escape
#: hatch for running several instances against separate registries.
STATE_DIR_ENV_VAR = "CALLIOPE_STUDIO_STATE_DIR"

#: What `platformdirs` is asked for, and what the registry inside it is called.
STATE_DIR_NAME = "calliope-studio"
REGISTRY_FILENAME = "workspaces.json"

#: State directories used under earlier names, oldest first. Read once, to seed a
#: fresh one; see `carry_over_registry`.
LEGACY_STATE_DIR_NAMES = ("calligraph",)


class WorkspaceNotFound(KeyError):
    """Raised when a workspace id is not in the registry, or its path is gone."""


@dataclass(frozen=True)
class Workspace:
    """A model definition folder that the user has opened."""

    id: str
    path: Path
    name: str
    opened_at: datetime
    #: How many finished runs to keep. `None` keeps everything, which is a
    #: legitimate choice for a small model and a terrible one for a large one —
    #: hence a setting rather than a constant. Stored in the registry rather than
    #: beside the model, because it is a preference about the machine's disk, not
    #: a property of the model definition.
    run_retention: int | None = DEFAULT_RUN_RETENTION

    def as_dict(self) -> dict:
        """Serialises for the API.

        The frontend still models a project containing versions, so a workspace
        is presented as both: one project, with a single version sharing its id.
        Phase 3 collapses this.
        """
        return {
            "id": self.id,
            "name": self.name,
            "description": str(self.path),
            "created_at": self.opened_at.isoformat(),
        }


def default_registry_path() -> Path:
    """Where the workspace registry lives, honouring the state-dir override.

    Read on each call rather than at import, so that setting the environment
    variable in a fixture takes effect for code that constructs its own
    `LocalStorage`.
    """
    override = os.environ.get(STATE_DIR_ENV_VAR)
    state_dir = (
        Path(override)
        if override
        else Path(platformdirs.user_state_dir(STATE_DIR_NAME))
    )
    return state_dir / REGISTRY_FILENAME


def legacy_registry_paths() -> list[Path]:
    """Where earlier names kept the registry, newest first."""
    return [
        Path(platformdirs.user_state_dir(name)) / REGISTRY_FILENAME
        for name in reversed(LEGACY_STATE_DIR_NAMES)
    ]


def carry_over_registry(registry: Path, candidates: Iterable[Path]) -> bool:
    """Seeds a fresh state directory from the one an earlier name used.

    The registry is the user's list of models, and it is the only thing in the
    state directory worth anything — losing it means every model they have opened
    silently disappears from the recents list. Renaming the application moves the
    directory `platformdirs` hands out, so without this the first launch under
    the new name looks like a fresh install.

    Copied rather than moved, so an installation under the old name still works.
    Best-effort: a failure here is not worth refusing to start over, and the cost
    is a recents list the user rebuilds by opening their models again.

    Only ever called for the *default* location. An explicitly chosen state
    directory — `$CALLIOPE_STUDIO_STATE_DIR`, which the suite sets for every
    test — means the caller has said where the registry is, and quietly
    populating it from somewhere else would be the opposite of that.
    """
    if registry.exists():
        return False
    for legacy in candidates:
        if not legacy.is_file():
            continue
        try:
            registry.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(legacy, registry)
        except OSError:
            return False
        return True
    return False


def _migrate_legacy_data_dir(workspace_path: Path) -> None:
    """Renames an earlier run-output directory to the current one.

    A single rename on open, rather than teaching every lookup about three
    possible locations forever. Does nothing if there is nothing to move, or if
    the current one already exists — in that case it is authoritative and the old
    one is left alone rather than merged, because silently combining two run
    histories is worse than leaving one behind (and `EXCLUDED_NAMES` still hides
    it).

    Newest legacy name first, so a workspace carrying both `.calligraph/` and
    `calligraph/` promotes the one that was already authoritative under the old
    rules and leaves the other where it is, exactly as before.
    """
    current = workspace_path / WORKSPACE_DATA_DIR
    if current.exists():
        return
    for name in reversed(LEGACY_WORKSPACE_DATA_DIRS):
        legacy = workspace_path / name
        if not legacy.is_dir():
            continue
        try:
            legacy.rename(current)
        except OSError:
            # A read-only or otherwise awkward workspace. Not worth failing to
            # open a model over; the old directory simply stays where it is.
            pass
        return


def _retention_of(entry: dict) -> int | None:
    """Reads a registry entry's run retention, tolerating anything it may hold.

    A registry written before this setting existed has no key at all, and one
    edited by hand can hold anything. Neither is worth failing to open a model
    over, so both fall back to the default.
    """
    if "run_retention" not in entry:
        return DEFAULT_RUN_RETENTION
    value = entry["run_retention"]
    if value is None:
        return None
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return DEFAULT_RUN_RETENTION


def workspace_id(path: Path) -> str:
    """A stable id for a folder, derived from its resolved path.

    Deriving rather than storing means the same folder keeps its id across
    registry rewrites, so bookmarked URLs survive.
    """
    resolved = str(Path(path).resolve())
    return hashlib.sha256(resolved.encode()).hexdigest()[:16]


class LocalStorage:
    """Tracks opened workspaces in a registry file under the user state dir."""

    def __init__(self, registry_path: Path | None = None) -> None:
        self.registry_path = registry_path or default_registry_path()
        if registry_path is None and not os.environ.get(STATE_DIR_ENV_VAR):
            carry_over_registry(self.registry_path, legacy_registry_paths())
        #: Created on first use; see `validations_dir`.
        self._validations_root: Path | None = None
        #: Created on first use; see `resolutions_dir`.
        self._resolutions_root: Path | None = None

    # -- registry file ----------------------------------------------------

    def _read_registry(self) -> list[dict]:
        try:
            raw = json.loads(self.registry_path.read_text())
        except (OSError, json.JSONDecodeError):
            # A corrupt or missing registry is not worth failing over; the
            # workspaces themselves are the real data.
            return []
        return raw if isinstance(raw, list) else []

    def _write_registry(self, entries: list[dict]) -> None:
        self.registry_path.parent.mkdir(parents=True, exist_ok=True)
        # Atomic replace, so an interrupted write cannot truncate the registry.
        fd, tmp = tempfile.mkstemp(dir=self.registry_path.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(entries, fh, indent=2)
            os.replace(tmp, self.registry_path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    # -- public interface -------------------------------------------------

    def list(self) -> list[Workspace]:
        """Returns registered workspaces, most recently opened first.

        Entries whose folder has since been deleted are pruned rather than
        raising, so a stale registry cannot break the projects list.
        """
        entries = self._read_registry()
        live, kept = [], []
        for entry in entries:
            try:
                path = Path(entry["path"])
                opened_at = datetime.fromisoformat(entry["opened_at"])
            except (KeyError, TypeError, ValueError):
                continue
            if not path.is_dir():
                continue
            kept.append(entry)
            live.append(
                Workspace(
                    id=workspace_id(path),
                    path=path,
                    name=entry.get("name") or path.name,
                    opened_at=opened_at,
                    run_retention=_retention_of(entry),
                )
            )
        if len(kept) != len(entries):
            self._write_registry(kept)
        live.sort(key=lambda w: w.opened_at, reverse=True)
        return live

    def get(self, id_: str) -> Workspace:
        """Looks up a workspace by id."""
        for workspace in self.list():
            if workspace.id == id_:
                return workspace
        raise WorkspaceNotFound(id_)

    def open(self, path: Path) -> Workspace:
        """Registers a folder as a workspace, refreshing it if already present."""
        resolved = Path(path).resolve()
        if not resolved.is_dir():
            raise NotADirectoryError(resolved)

        _migrate_legacy_data_dir(resolved)

        existing = [
            entry
            for entry in self._read_registry()
            if entry.get("path") == str(resolved)
        ]
        workspace = Workspace(
            id=workspace_id(resolved),
            path=resolved,
            name=resolved.name,
            opened_at=datetime.now(timezone.utc),
            # Re-opening a model must not silently reset its settings: the entry
            # is rewritten to move it to the top of the list, and anything not
            # carried across here is lost every time the model is opened.
            run_retention=(
                _retention_of(existing[0]) if existing else DEFAULT_RUN_RETENTION
            ),
        )
        entries = [
            entry
            for entry in self._read_registry()
            if entry.get("path") != str(resolved)
        ]
        entries.insert(0, self._entry_for(workspace))
        self._write_registry(entries)
        return workspace

    def forget(self, workspace: Workspace) -> None:
        """Removes a workspace from the recents list.

        Touches only the registry: the folder, the model and its runs are the
        user's own files and stay exactly where they are. Until now the only way
        an entry could leave this list was to delete the folder from disk, which
        is a wildly disproportionate way to say "I am not working on that any
        more".
        """
        self._write_registry(
            [
                entry
                for entry in self._read_registry()
                if entry.get("path") != str(workspace.path)
            ]
        )

    @staticmethod
    def _entry_for(workspace: Workspace) -> dict:
        return {
            "path": str(workspace.path),
            "name": workspace.name,
            "opened_at": workspace.opened_at.isoformat(),
            "run_retention": workspace.run_retention,
        }

    def set_run_retention(self, workspace: Workspace, keep: int | None) -> Workspace:
        """Changes how many finished runs this workspace keeps.

        Takes effect the next time a run *starts*, which is when pruning happens
        — lowering the limit does not delete anything on the spot. That is
        deliberate: a settings change should not be a destructive action.

        Raises:
            WorkspaceNotFound: If the workspace is no longer registered.
        """
        updated = dataclasses.replace(
            workspace, run_retention=None if keep is None else max(1, int(keep))
        )
        entries = self._read_registry()
        for index, entry in enumerate(entries):
            if entry.get("path") == str(workspace.path):
                entries[index] = {**entry, "run_retention": updated.run_retention}
                self._write_registry(entries)
                return updated
        raise WorkspaceNotFound(workspace.id)

    def runs_dir(self, workspace: Workspace, *, create: bool = False) -> Path:
        """Directory holding this workspace's run outputs.

        Runs live beside the model rather than in a central location so that a
        model folder is self-contained and can be moved or shared with its
        results intact.

        Args:
            workspace: Whose runs to locate.
            create: Whether to create the directory. Defaults to False, because
                the common caller is *listing* runs — which the interface does on
                load — and listing must not be what brings the directory into
                existence. Opening a model to look at it used to leave a
                directory behind.

        Returns:
            The path, which may not exist unless `create` was passed.
        """
        path = workspace.path / WORKSPACE_DATA_DIR / "runs"
        if create:
            path.mkdir(parents=True, exist_ok=True)
            self._write_gitignore(workspace)
        return path

    def _write_gitignore(self, workspace: Workspace) -> None:
        """Ensures the data directory carries a `.gitignore`.

        Written on first use rather than on open, so that a workspace nothing has
        been run in stays untouched.
        """
        marker = workspace.path / WORKSPACE_DATA_DIR / ".gitignore"
        if not marker.exists():
            marker.write_text(GITIGNORE_CONTENTS)

    def validations_dir(self) -> Path:
        """Scratch root for deep-validation attempts, in the system temp dir.

        Not in the workspace. A validation produces no artefact anyone wants to
        keep — only a pass/fail and some messages — yet every click used to leave
        a permanent UUID-named directory beside the user's model, unreachable and
        unremovable from the interface.

        Removed when the process exits, and pruned as attempts accumulate, so
        nothing survives a session. That in turn means a validation cannot be
        looked up after a restart, which is correct: there is nothing to recover.
        """
        if self._validations_root is None:
            root = Path(tempfile.mkdtemp(prefix="calliope-studio-validations-"))
            atexit.register(shutil.rmtree, root, True)
            self._validations_root = root
        self._validations_root.mkdir(parents=True, exist_ok=True)
        return self._validations_root

    def resolutions_dir(self) -> Path:
        """Scratch root for resolved model definitions, in the system temp dir.

        Not in the workspace, for the same reason validations are not: a resolution
        is derived from the model definition and rebuilt whenever the definition
        changes, so keeping one beside the user's model would be litter. It is also
        why it need not survive a restart — the first request after one rebuilds it.
        """
        if self._resolutions_root is None:
            root = Path(tempfile.mkdtemp(prefix="calliope-studio-resolutions-"))
            atexit.register(shutil.rmtree, root, True)
            self._resolutions_root = root
        self._resolutions_root.mkdir(parents=True, exist_ok=True)
        return self._resolutions_root

    def prune_validations(self, keep: int = VALIDATION_RETENTION) -> None:
        """Removes finished validation attempts beyond the newest `keep`.

        Only finished ones: a running validation is still being polled. Keeping a
        few rather than deleting on read means a client that polls once more
        after seeing the result still gets an answer.
        """
        if self._validations_root is None:
            return
        finished = [
            directory
            for directory in self._validations_root.glob("*/")
            if (directory / protocol.OUTCOME_FILE).is_file()
        ]
        finished.sort(key=lambda directory: directory.stat().st_mtime, reverse=True)
        for directory in finished[keep:]:
            shutil.rmtree(directory, ignore_errors=True)

    def prune_runs(
        self,
        workspace: Workspace,
        keep: int = DEFAULT_RUN_RETENTION,
        # Quoted: this class has a `list` method, which shadows the builtin for
        # every annotation evaluated after it.
    ) -> "list[str]":
        """Removes the oldest finished runs beyond the newest `keep`.

        Enforced when a run starts rather than when one completes: the worker is
        the only thing that knows a run finished, and it must not reach back into
        the server's storage to tidy up. Starting is also a deliberate user
        action, so pruning cannot race a worker writing its results.

        Never removes a run that has not finished, however old it looks.

        Returns:
            The ids of the runs that were removed.
        """
        root = self.runs_dir(workspace)
        if not root.is_dir() or keep < 0:
            return []

        finished = []
        for directory in root.glob("*/"):
            if not (directory / protocol.REQUEST_FILE).is_file():
                continue
            if protocol.read_outcome(directory) is None and not protocol.is_cancelled(
                directory
            ):
                continue  # still running, or died without a verdict
            finished.append(directory)

        finished.sort(key=lambda directory: directory.stat().st_mtime, reverse=True)
        removed = []
        for directory in finished[keep:]:
            shutil.rmtree(directory, ignore_errors=True)
            removed.append(directory.name)
        return removed

    def run_roots(self) -> Iterator[Path]:
        """Every directory that may hold run directories, across all workspaces.

        Used to resolve a run id that this process did not start — after a
        restart, nothing is left in memory to map an id to a directory.

        Deliberately creates nothing, unlike `runs_dir(create=True)`: this is
        called to *look a run up*, and searching must not have the side effect of
        littering the data directory into every folder the user has ever opened.

        Validations are absent on purpose. They live in a temporary directory
        that does not outlive the process, so there is never an old one to find.
        """
        for workspace in self.list():
            yield workspace.path / WORKSPACE_DATA_DIR / "runs"
