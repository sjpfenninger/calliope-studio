"""The file tree, and reading and writing plain text files."""

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel

from calliope_studio.modeldef.paths import is_excluded, walk_files, write_text_atomic
from calliope_studio.server.deps import (
    get_workspace,
    require_file,
    require_text,
    resolve_path,
    resolve_writable_path,
)
from calliope_studio.server.storage import Workspace

router = APIRouter(tags=["files"])


class FileContent(BaseModel):
    content: str = ""


#: The only content types this server will name. Everything else is served as
#: an opaque download.
#:
#: Not `mimetypes.guess_type`, which answers for the open set: an `.html` file
#: sitting in a model folder, served as `text/html` from the app's own origin,
#: is a script-execution hole. Naming only pictures keeps the route to the one
#: job it has.
IMAGE_MEDIA_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
}


def _check_creatable(workspace: Workspace, file_path: str) -> Path:
    """Resolves a path to create at, refusing what could not then be found.

    The same rules `modeldef.scaffold.create_model` applies to a new model
    folder. The excluded-name check is the one that is easy to miss and the most
    confusing to hit: `calliope-studio/` and `.git/` are filtered out of the
    tree, so creating something inside one would appear to do nothing at all.
    """
    root = Path(workspace.path).resolve()
    path = resolve_path(workspace, file_path)
    relative = path.relative_to(root)

    if not relative.parts:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="A name is required."
        )
    if is_excluded(relative):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That name is hidden from the file tree.",
        )
    if any(part.startswith(".") for part in relative.parts):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A name starting with a dot would be hidden.",
        )
    if path.exists():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="There is already something at that path.",
        )
    # Walked rather than left to `mkdir`, whose `NotADirectoryError` would reach
    # the client as an unexplained 500.
    for ancestor in list(relative.parents)[:-1]:
        if (root / ancestor).is_file():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"“{ancestor}” is a file, so nothing can be created inside it.",
            )
    return path


@router.get("/versions/{id}/files/")
def file_tree(workspace: Workspace = Depends(get_workspace)) -> list[dict]:
    return walk_files(workspace.path)


@router.get("/versions/{id}/files/{file_path:path}")
def read_file(file_path: str, workspace: Workspace = Depends(get_workspace)) -> dict:
    path = require_file(resolve_path(workspace, file_path))
    return {"content": require_text(path)}


@router.get("/versions/{id}/raw/{file_path:path}")
def read_raw(
    file_path: str, workspace: Workspace = Depends(get_workspace)
) -> FileResponse:
    """Serves a file's bytes, for the image viewer.

    The only route under `/api` that returns something other than JSON. Both
    headers are deliberate: `nosniff` stops the browser second-guessing the
    conservative content type above, and `sandbox` gives anything that is served
    a null origin, so an SVG opened directly in a tab cannot reach the app.
    """
    path = require_file(resolve_path(workspace, file_path))
    media_type = IMAGE_MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(
        path,
        media_type=media_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
        },
    )


@router.post("/versions/{id}/files/{file_path:path}")
def create_file(file_path: str, workspace: Workspace = Depends(get_workspace)) -> dict:
    """Creates an empty file, refusing to overwrite one.

    A separate verb from `write_file` below, which has no existence check at
    all — saving a buffer is meant to replace what is there, and creating is
    meant not to.
    """
    path = _check_creatable(workspace, file_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()
    return {"ok": True, "path": file_path}


@router.post("/versions/{id}/folders/{file_path:path}")
def create_folder(
    file_path: str, workspace: Workspace = Depends(get_workspace)
) -> dict:
    path = _check_creatable(workspace, file_path)
    path.mkdir(parents=True)
    return {"ok": True, "path": file_path}


@router.put("/versions/{id}/files/{file_path:path}")
def write_file(
    file_path: str, body: FileContent, workspace: Workspace = Depends(get_workspace)
) -> dict:
    path = resolve_writable_path(workspace, file_path)
    # Through `yaml_io._write`, which is UTF-8, `newline=""` and atomic.
    #
    # `newline=""` writes the string's bytes untouched. Without it Python
    # translates every `\n` to `os.linesep`, which on Windows means *every save
    # rewrites the whole file* with CRLF — while `require_text` reads through
    # `read_bytes().decode()` and so returns exactly what is on disk. The two
    # were asymmetric, which breaks the property the editors live by: a no-op
    # save must not change the file. Not `newline="\n"` either: the requirement
    # is to preserve what the user's file already had, including one that is
    # legitimately CRLF throughout.
    #
    # UTF-8 for the same reason `require_text` reads that way — the two halves of
    # one round trip cannot use different codecs — and atomic because this is the
    # user's model definition and there is no backup of it anywhere.
    write_text_atomic(path, body.content)
    return {"ok": True}
