"""The file tree, and reading and writing plain text files."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from calligraph.modeldef.paths import walk_files
from calligraph.server.deps import get_workspace, require_file, resolve_path
from calligraph.server.storage import Workspace

router = APIRouter(tags=["files"])


class FileContent(BaseModel):
    content: str = ""


@router.get("/versions/{id}/files/")
def file_tree(workspace: Workspace = Depends(get_workspace)) -> list[dict]:
    return walk_files(workspace.path)


@router.get("/versions/{id}/files/{file_path:path}")
def read_file(file_path: str, workspace: Workspace = Depends(get_workspace)) -> dict:
    path = require_file(resolve_path(workspace, file_path))
    # `errors="replace"` so that a stray non-UTF-8 byte shows as a replacement
    # character in the editor rather than failing the whole request.
    return {"content": path.read_text(errors="replace")}


@router.put("/versions/{id}/files/{file_path:path}")
def write_file(
    file_path: str, body: FileContent, workspace: Workspace = Depends(get_workspace)
) -> dict:
    path = resolve_path(workspace, file_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body.content)
    return {"ok": True}
