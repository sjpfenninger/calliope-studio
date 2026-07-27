"""CSV data tables for the grid editor."""

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from calliope_studio.modeldef.csv_io import parse_csv, serialize_csv
from calliope_studio.server.deps import get_workspace, require_file, resolve_path
from calliope_studio.server.storage import Workspace

router = APIRouter(tags=["csv"])


class CsvBody(BaseModel):
    columns: list[dict] = []
    rows: list[list[Any]] = []


@router.get("/versions/{id}/csv/{file_path:path}")
def read_csv(file_path: str, workspace: Workspace = Depends(get_workspace)) -> dict:
    path = require_file(resolve_path(workspace, file_path))
    return parse_csv(path.read_bytes())


@router.put("/versions/{id}/csv/{file_path:path}")
def write_csv(
    file_path: str, body: CsvBody, workspace: Workspace = Depends(get_workspace)
) -> dict:
    path = resolve_path(workspace, file_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(serialize_csv(body.columns, body.rows))
    return {"ok": True}
