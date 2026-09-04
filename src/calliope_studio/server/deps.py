"""Shared request dependencies.

These are the injection points for the deployment seams. Locally, storage is a
folder registry and there is no authentication; a hosted deployment would swap
the implementations here without touching a route handler.
"""

from pathlib import Path

from fastapi import Depends, HTTPException, Request, status

from calliope_studio.modeldef.paths import (
    UnsafePath,
    content_revision,
    is_excluded,
    safe_path,
)
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


def resolve_writable_path(workspace: Workspace, file_path: str) -> Path:
    """Resolves a path a request may *write* to.

    Traversal is not the only thing a write has to refuse. `EXCLUDED_NAMES` is
    what keeps run outputs and `.git/` out of the editor's file tree, and
    `files._check_creatable` already applies it — but only on the create verbs.
    `PUT` went through `resolve_path`, which does not, so a client could write
    over `calliope-studio/runs/{id}/snapshot/model.yaml` and with it the claim
    that a run's definition is frozen at the moment it starts. `.git/hooks/*`
    was reachable the same way.

    Reads stay permissive: the tree hides these paths rather than forbidding
    them, and the run routes serve a snapshot deliberately.
    """
    path = resolve_path(workspace, file_path)
    root = Path(workspace.path).resolve()
    if is_excluded(path.relative_to(root)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That path is not part of the model definition.",
        )
    return path


def check_revision(path: Path, expected: str | None) -> None:
    """Refuses a write whose baseline is no longer what is on disk.

    A client that read a file gets `paths.content_revision` with it and sends
    it back with the save. If the file has changed in between — a second
    browser tab, an editor outside the app, the math panel writing `config` —
    the save would silently revert that change: every section write deletes
    the keys absent from its payload, so the older state does not merely win,
    it erases. A client that sends nothing is an old one and is let through.

    Raises:
        HTTPException: 409, with the current revision in the detail so the
            client can say what happened rather than merely that it did.
    """
    if expected is None:
        return
    current = content_revision(path)
    if current is not None and current != expected:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This file changed on disk after it was loaded here — in another "
                "tab or outside the app. Reload it to pick up the change."
            ),
            headers={"X-Content-Revision": current},
        )


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


def require_within_size(path: Path) -> Path:
    """Refuses a file too large to hand to the browser whole.

    The same cap as `require_text`, for the readers that do not go through it.
    `parse_csv(path.read_bytes())` had none: a `data_tables/` holding an hourly
    profile for a few hundred nodes is a few hundred megabytes, and clicking it
    in the file tree read it whole, exploded it into a `list[list[str]]` several
    times that size, and serialised the lot as JSON.
    """
    size = path.stat().st_size
    if size > MAX_TEXT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"This file is too large to open ({size // 1024} kB).",
        )
    return path


def require_text(path: Path) -> str:
    """Reads a file as text; see `decode_text`, whose lossy flag this drops."""
    return decode_text(path)[0]


def is_binary(path: Path) -> bool:
    """Whether a file fails the NUL sniff `decode_text` refuses on.

    The same test, asked rather than enforced. A comparison has two files and
    either may be binary, so the answer has to be reportable — "this pair
    cannot be shown as text" — where opening one file for editing can simply be
    a 415. Size is not consulted: a file too large to display is still text, and
    the caller finds that out from `decode_text` when it asks for the content.
    """
    try:
        with path.open("rb") as handle:
            return b"\0" in handle.read(NUL_SNIFF_BYTES)
    except OSError:
        return False


def decode_text(path: Path) -> tuple[str, bool]:
    """Reads a file as text, refusing what is not text and what is too big.

    Returns:
        The text, and whether decoding it lost anything. A stray Latin-1 byte
        is replaced with U+FFFD so the file still opens — and a save of that
        buffer would write the replacement over the original byte, which is
        silent corruption of a file the user opened only to look at. The flag
        is what lets the editor refuse to save such a buffer.

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
    require_within_size(path)
    data = path.read_bytes()
    if b"\0" in data[:NUL_SNIFF_BYTES]:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="This file is not text.",
        )
    try:
        return data.decode("utf-8"), False
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="replace"), True
