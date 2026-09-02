"""CSV data tables for the grid editor."""

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from calliope_studio.modeldef.csv_io import parse_csv, serialize_csv
from calliope_studio.modeldef.paths import write_bytes_atomic
from calliope_studio.server.deps import (
    get_workspace,
    require_file,
    require_within_size,
    resolve_path,
    resolve_writable_path,
)
from calliope_studio.server.storage import Workspace

router = APIRouter(tags=["csv"])


class CsvBody(BaseModel):
    columns: list[dict] = []
    rows: list[list[Any]] = []


@router.get("/versions/{id}/csv/{file_path:path}")
def read_csv(file_path: str, workspace: Workspace = Depends(get_workspace)) -> dict:
    path = require_within_size(require_file(resolve_path(workspace, file_path)))
    return parse_csv(path.read_bytes())


@router.put("/versions/{id}/csv/{file_path:path}")
def write_csv(
    file_path: str, body: CsvBody, workspace: Workspace = Depends(get_workspace)
) -> dict:
    path = resolve_writable_path(workspace, file_path)
    # Bytes, not text, and `serialize_csv` pins `lineterminator="\n"`. That is
    # already the right pair and must stay one: switching this to the text
    # writer for consistency with the others would reintroduce the newline
    # translation they had to be fixed for. Atomic like the rest of them.
    write_bytes_atomic(path, serialize_csv(body.columns, body.rows))
    return {"ok": True}
