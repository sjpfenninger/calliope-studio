"""Reading and writing one top-level YAML section at a time.

This is what every structured editor is built on: the frontend edits a section
as a plain object and writes it back, while comments and formatting everywhere
else in the file survive untouched.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from calligraph.modeldef.yaml_io import SectionNotFound, read_section, write_section
from calligraph.server.deps import get_workspace, require_file, resolve_path
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
) -> dict:
    if body.data is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="data required."
        )
    path = require_file(resolve_path(workspace, file_path))
    try:
        write_section(path, section, body.data)
    except SectionNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Section '{section}' not found.",
        ) from None
    return {"ok": True}
