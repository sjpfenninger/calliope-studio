"""Where model definitions and run outputs live.

This is the local side of the storage seam. A *workspace* is simply a folder on
disk containing a Calliope model definition — the folder the user opened. There
is no database: a registry file records which folders have been opened, and run
metadata lives beside the model it came from.

A hosted deployment would provide a different implementation of the same
interface, backed by per-user server-managed directories.
"""

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import platformdirs

#: Directory created inside a workspace to hold run outputs.
WORKSPACE_DATA_DIR = ".calligraph"

#: Overrides where the registry is kept. Tests set this so that they cannot
#: write into the developer's real state directory, and it is a useful escape
#: hatch for running several instances against separate registries.
STATE_DIR_ENV_VAR = "CALLIGRAPH_STATE_DIR"


class WorkspaceNotFound(KeyError):
    """Raised when a workspace id is not in the registry, or its path is gone."""


@dataclass(frozen=True)
class Workspace:
    """A model definition folder that the user has opened."""

    id: str
    path: Path
    name: str
    opened_at: datetime

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
        Path(override) if override else Path(platformdirs.user_state_dir("calligraph"))
    )
    return state_dir / "workspaces.json"


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

        workspace = Workspace(
            id=workspace_id(resolved),
            path=resolved,
            name=resolved.name,
            opened_at=datetime.now(timezone.utc),
        )
        entries = [
            entry
            for entry in self._read_registry()
            if entry.get("path") != str(resolved)
        ]
        entries.insert(
            0,
            {
                "path": str(resolved),
                "name": workspace.name,
                "opened_at": workspace.opened_at.isoformat(),
            },
        )
        self._write_registry(entries)
        return workspace

    def runs_dir(self, workspace: Workspace) -> Path:
        """Directory holding this workspace's run outputs.

        Runs live beside the model rather than in a central location so that a
        model folder is self-contained and can be moved or shared with its
        results intact.
        """
        path = workspace.path / WORKSPACE_DATA_DIR / "runs"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def validations_dir(self, workspace: Workspace) -> Path:
        """Scratch directory for validation attempts.

        Kept apart from `runs_dir` so that validating a model does not clutter
        the run history with entries that never produced results.
        """
        path = workspace.path / WORKSPACE_DATA_DIR / "validations"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def run_roots(self) -> Iterator[Path]:
        """Every directory that may hold run directories, across all workspaces.

        Used to resolve a run id that this process did not start — after a
        restart, nothing is left in memory to map an id to a directory.

        Deliberately creates nothing, unlike `runs_dir`: this is called to *look
        a run up*, and searching must not have the side effect of littering the
        data directory into every folder the user has ever opened.
        """
        for workspace in self.list():
            base = workspace.path / WORKSPACE_DATA_DIR
            yield base / "runs"
            yield base / "validations"
