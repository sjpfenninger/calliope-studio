"""Shared request dependencies.

These are the injection points for the deployment seams. Locally, storage is a
folder registry and there is no authentication; a hosted deployment would swap
the implementations here without touching a route handler.
"""

from pathlib import Path

from fastapi import Depends, HTTPException, Request, status

from calligraph.modeldef.paths import UnsafePath, safe_path
from calligraph.runs.manager import RunManager
from calligraph.server.storage import LocalStorage, Workspace, WorkspaceNotFound


def get_storage(request: Request) -> LocalStorage:
    return request.app.state.storage


def get_runs(request: Request) -> RunManager:
    return request.app.state.runs


def get_workspace(id: str, storage: LocalStorage = Depends(get_storage)) -> Workspace:
    """Resolves a workspace id from the path, 404ing if unknown.

    The frontend still addresses a workspace as both a project and its single
    version, so the same dependency serves `/projects/{id}` and `/versions/{id}`.
    """
    try:
        return storage.get(id)
    except WorkspaceNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found."
        ) from None


def resolve_path(workspace: Workspace, file_path: str) -> Path:
    """Resolves a request path inside a workspace, rejecting traversal."""
    try:
        return safe_path(workspace.path, file_path)
    except UnsafePath:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid path."
        ) from None


def require_file(path: Path) -> Path:
    """404s if the resolved path is not an existing file."""
    if not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found."
        )
    return path
