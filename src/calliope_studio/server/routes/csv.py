"""CSV data tables for the grid editor."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from calliope_studio.modeldef.csv_io import parse_csv, serialize_csv, sniff_format
from calliope_studio.modeldef.paths import content_revision, write_bytes_atomic
from calliope_studio.server.deps import (
    check_revision,
    get_workspace,
    require_file,
    require_within_size,
    resolve_path,
    resolve_writable_path,
)
from calliope_studio.server.storage import Workspace

router = APIRouter(tags=["csv"])

#: How much of an existing file to look at for its byte-order mark and line
#: ending. The first line is enough for both.
SNIFF_BYTES = 4096


class CsvBody(BaseModel):
    columns: list[dict] = []
    rows: list[list[Any]] = []
    #: The file's revision when the grid was loaded; see `deps.check_revision`.
    revision: str | None = None


@router.get("/versions/{id}/csv/{file_path:path}")
def read_csv(file_path: str, workspace: Workspace = Depends(get_workspace)) -> dict:
    path = require_within_size(require_file(resolve_path(workspace, file_path)))
    try:
        payload = parse_csv(path.read_bytes())
    except UnicodeDecodeError:
        # The same answer `require_text` gives for a file that is not text,
        # rather than a 500 with nothing in it naming the file.
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="This file is not UTF-8 text.",
        ) from None
    payload["revision"] = content_revision(path)
    return payload


@router.put("/versions/{id}/csv/{file_path:path}")
def write_csv(
    file_path: str, body: CsvBody, workspace: Workspace = Depends(get_workspace)
) -> dict:
    path = resolve_writable_path(workspace, file_path)
    check_revision(path, body.revision)
    # Bytes, not text, so nothing translates the line ending: the writer puts
    # back whichever one the file already had, and the byte-order mark with it.
    # Switching this to the text writer for consistency with the others would
    # reintroduce the newline translation they had to be fixed for. Atomic like
    # the rest of them.
    bom, lineterminator = (
        sniff_format(path.read_bytes()[:SNIFF_BYTES])
        if path.is_file()
        else (False, "\n")
    )
    write_bytes_atomic(
        path,
        serialize_csv(body.columns, body.rows, bom=bom, lineterminator=lineterminator),
    )
    return {"ok": True, "revision": content_revision(path)}
