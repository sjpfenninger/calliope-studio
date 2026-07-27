"""Reading and writing one top-level YAML section at a time.

This is what every structured editor is built on: the frontend edits a section
as a plain object and writes it back, while comments and formatting everywhere
else in the file survive untouched.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from calligraph.modeldef.entities import harmonise_coordinates
from calligraph.modeldef.yaml_io import SectionNotFound, read_section, write_section
from calligraph.server.deps import (
    get_resolver,
    get_workspace,
    require_file,
    resolve_path,
)
from calligraph.server.resolution import Resolver
from calligraph.server.storage import Workspace

router = APIRouter(tags=["yaml"])


class SectionBody(BaseModel):
    data: Any


@router.get("/versions/{id}/yaml-section/{file_path:path}")
def get_section(
    file_path: str,
    section: str = Query(..., description="Top-level key to read."),
    workspace: Workspace = Depends(get_workspace),
) -> dict:
    path = require_file(resolve_path(workspace, file_path))
    try:
        return {"section": section, "data": read_section(path, section)}
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
    path = require_file(resolve_path(workspace, file_path))
    data = harmonise_coordinates(body.data) if section == "nodes" else body.data
    try:
        write_section(path, section, data)
    except SectionNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Section '{section}' not found.",
        ) from None
    # The definition has changed, so what it *means* has too. Started here rather
    # than left to the next request for it, so the read is already under way while
    # the user is still looking at the form they saved. The task id is not returned:
    # whatever needs the result asks for it — `GET /geo/` reports the state — and
    # this response is a write acknowledgement, not a handle.
    resolver.refresh(workspace)
    return {"ok": True}
