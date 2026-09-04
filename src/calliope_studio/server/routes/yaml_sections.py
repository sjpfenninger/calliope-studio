"""Reading and writing one top-level YAML section at a time.

This is what every structured editor is built on: the frontend edits a section
as a plain object and writes it back, while comments and formatting everywhere
else in the file survive untouched.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from calliope_studio.modeldef.entities import harmonise_coordinates
from calliope_studio.modeldef.paths import content_revision
from calliope_studio.modeldef.yaml_io import (
    SectionNotFound,
    read_section,
    write_section,
)
from calliope_studio.server.deps import (
    check_revision,
    get_resolver,
    get_workspace,
    require_file,
    resolve_path,
    resolve_writable_path,
)
from calliope_studio.server.resolution import Resolver
from calliope_studio.server.storage import Workspace

router = APIRouter(tags=["yaml"])


class SectionBody(BaseModel):
    data: Any
    #: The file's revision when the section was read; see `deps.check_revision`.
    revision: str | None = None
    #: New key → the old key it replaces, so a renamed entry keeps its place and
    #: its comments instead of being deleted and appended; see `yaml_io`.
    renames: dict[str, str] = Field(default_factory=dict)


@router.get("/versions/{id}/yaml-section/{file_path:path}")
def get_section(
    file_path: str,
    section: str = Query(..., description="Top-level key to read."),
    workspace: Workspace = Depends(get_workspace),
) -> dict:
    path = require_file(resolve_path(workspace, file_path))
    try:
        return {
            "section": section,
            "data": read_section(path, section),
            "revision": content_revision(path),
        }
    except SectionNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Section '{section}' not found.",
        ) from None


@router.put("/versions/{id}/yaml-section/{file_path:path}")
def put_section(
    file_path: str,
    body: SectionBody,
    section: str = Query(..., description="Top-level key to replace."),
    workspace: Workspace = Depends(get_workspace),
    resolver: Resolver = Depends(get_resolver),
) -> dict:
    if body.data is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="data required."
        )
    path = require_file(resolve_writable_path(workspace, file_path))
    check_revision(path, body.revision)
    try:
        # After the merge, not before: the merge keeps the file's `-2.0` against
        # an incoming `-2`, so whether a pair is mixed is only known once it has
        # decided which spellings survive.
        write_section(
            path,
            section,
            body.data,
            renames=body.renames,
            after_merge=harmonise_coordinates if section == "nodes" else None,
        )
    except SectionNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Section '{section}' not found.",
        ) from None
    except ValueError as exc:
        # A rename onto a name still in use, or of one that is not there. Nothing
        # was written: the renames are checked before the merge touches the file.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from None
    # The definition has changed, so what it *means* has too. Started here rather
    # than left to the next request for it, so the read is already under way while
    # the user is still looking at the form they saved. The task id is not returned:
    # whatever needs the result asks for it — `GET /geo/` reports the state — and
    # this response is a write acknowledgement, not a handle.
    resolver.refresh(workspace)
    return {"ok": True, "revision": content_revision(path)}
