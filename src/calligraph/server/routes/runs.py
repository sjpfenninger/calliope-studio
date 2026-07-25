"""Starting runs, watching them, and cancelling them."""

import json
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse

from calligraph.modeldef.imports import find_model_yaml
from calligraph.runs import protocol
from calligraph.runs.manager import RunManager
from calligraph.server.deps import get_runs, get_storage, get_workspace
from calligraph.server.storage import LocalStorage, Workspace

router = APIRouter(tags=["runs"])


@router.get("/versions/{id}/runs/")
def list_runs(
    workspace: Workspace = Depends(get_workspace),
    storage: LocalStorage = Depends(get_storage),
    runs: RunManager = Depends(get_runs),
) -> list[dict]:
    """Run history for a workspace, rediscovered from disk.

    Runs outlive the server process, so history survives a restart.
    """
    return [record.as_dict() for record in runs.discover(storage.runs_dir(workspace))]


@router.post("/versions/{id}/runs/", status_code=status.HTTP_201_CREATED)
def create_run(
    workspace: Workspace = Depends(get_workspace),
    storage: LocalStorage = Depends(get_storage),
    runs: RunManager = Depends(get_runs),
) -> dict:
    model_yaml = find_model_yaml(workspace.path)
    if model_yaml is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No model.yaml found in this workspace.",
        )

    record = runs.start(
        storage.runs_dir(workspace),
        protocol.RunRequest(workspace=str(workspace.path), model_file=model_yaml.name),
    )
    return record.as_dict()


@router.get("/runs/{run_id}/")
def get_run(run_id: str, runs: RunManager = Depends(get_runs)) -> dict:
    try:
        return runs.get(run_id).as_dict()
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Run not found."
        ) from None


@router.post("/runs/{run_id}/cancel/")
async def cancel_run(run_id: str, runs: RunManager = Depends(get_runs)) -> dict:
    """Stops a run by killing its process group.

    Calliope has no interrupt API, so there is no gentler option; the process
    group rather than the process alone, so the solver goes too.
    """
    try:
        await runs.cancel(run_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Run not found."
        ) from None
    return runs.get(run_id).as_dict()


@router.get("/runs/{run_id}/logs/")
async def stream_logs(
    run_id: str, runs: RunManager = Depends(get_runs)
) -> StreamingResponse:
    """Server-sent events carrying the run's log and stage transitions.

    The stream replays from the beginning, so a client that connects late or
    reconnects still receives the whole log.
    """
    try:
        runs.run_dir(run_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Run not found."
        ) from None

    async def events() -> AsyncIterator[str]:
        async for event in runs.stream(run_id):
            if event.get("t") == "done":
                yield f"event: done\ndata: {json.dumps(event)}\n\n"
            elif event.get("t") == "stage":
                yield f"event: stage\ndata: {json.dumps(event)}\n\n"
            else:
                # The frontend's default handler appends these as log lines.
                yield f"data: {event.get('msg', '')}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Stops a reverse proxy buffering the stream into uselessness.
            "X-Accel-Buffering": "no",
        },
    )
