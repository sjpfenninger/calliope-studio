"""Shared request dependencies.

These are the injection points for the deployment seams. Locally, storage is a
folder registry and there is no authentication; a hosted deployment would swap
the implementations here without touching a route handler.
"""

from pathlib import Path

from fastapi import Depends, HTTPException, Request, status

from calliope_studio.modeldef.paths import UnsafePath, safe_path
from calliope_studio.results.store import ResultStore
from calliope_studio.runs.manager import RunManager
from calliope_studio.server.resolution import Resolver
from calliope_studio.server.storage import LocalStorage, Workspace, WorkspaceNotFound


def get_storage(request: Request) -> LocalStorage:
    return request.app.state.storage


def get_runs(request: Request) -> RunManager:
    return request.app.state.runs


def get_results(request: Request) -> ResultStore:
    return request.app.state.results


def get_resolver(request: Request) -> Resolver:
    return request.app.state.resolver


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


def resolve_within(base: Path, file_path: str) -> Path:
    """Resolves a request path inside an arbitrary root, rejecting traversal.

    The same guard as `resolve_path`, for roots that are not workspaces — chiefly
    a run's frozen snapshot directory. `safe_path` stays the only place a
    request-supplied path reaches the filesystem.
    """
    try:
        return safe_path(base, file_path)
    except UnsafePath:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid path."
        ) from None


def resolve_path(workspace: Workspace, file_path: str) -> Path:
    """Resolves a request path inside a workspace, rejecting traversal."""
    return resolve_within(workspace.path, file_path)


def require_file(path: Path) -> Path:
    """404s if the resolved path is not an existing file."""
    if not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found."
        )
    return path


#: The largest file that will be handed to the editor as text.
#:
#: There was no cap anywhere between reading a file and `createModel`, so a
#: multi-megabyte `.nc` became a JSON string, was escaped into a larger one, and
#: was then given to Monaco.
MAX_TEXT_BYTES = 8 * 1024 * 1024

#: How far into a file to look for a NUL byte before calling it binary.
NUL_SNIFF_BYTES = 8000


def require_text(path: Path) -> str:
    """Reads a file as text, refusing what is not text and what is too big.

    Both refusals used to be silent successes. `read_text(errors="replace")`
    cannot fail, so a `.png` came back as HTTP 200 holding a megabyte of U+FFFD,
    Monaco opened it, and Ctrl/Cmd+S wrote that transcription back over the
    original bytes.

    A NUL byte near the start is git's own binary test, and it is the right one
    here because it keeps the tolerance the `errors="replace"` was chosen for: a
    YAML file carrying one stray Latin-1 byte is still a file somebody is
    editing, and it must still open. A strict decode would reject it. UTF-16
    text is called binary by this rule, which is honest — the editor cannot
    round-trip it either.

    The explicit `encoding` matters as much as the sniff. `Path.read_text` with
    no encoding uses the locale default, so on a Western Windows box a binary
    decoded as cp1252 into plausible-looking text rather than replacement
    characters — the same corruption with nothing on screen to reveal it.
    """
    size = path.stat().st_size
    if size > MAX_TEXT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"This file is too large to open ({size // 1024} kB).",
        )
    data = path.read_bytes()
    if b"\0" in data[:NUL_SNIFF_BYTES]:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="This file is not text.",
        )
    return data.decode("utf-8", errors="replace")
