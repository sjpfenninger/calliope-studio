"""Starting runs, watching them, cancelling them, and reading what they froze.

The snapshot endpoints deliberately mirror the shapes of `files.py` and `csv.py`,
so the frontend's file tree and grid can be pointed at a run instead of a
workspace without any other change. All of them are read-only: history is not
editable.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from calligraph.modeldef.csv_io import parse_csv
from calligraph.modeldef.imports import (
    component_tree,
    find_model_yaml,
    import_graph,
    scenario_names,
)
from calligraph.modeldef.paths import walk_files
from calligraph.modeldef.snapshot import write_snapshot
from calligraph.results.store import ResultStore
from calligraph.runs import protocol
from calligraph.runs.manager import (
    TERMINAL_STATUSES,
    RunManager,
    RunRecord,
    RunStillActive,
)
from calligraph.server.deps import (
    get_results,
    get_runs,
    get_storage,
    get_workspace,
    require_file,
    resolve_within,
)
from calligraph.server.storage import LocalStorage, Workspace

router = APIRouter(tags=["runs"])


class RunOptions(BaseModel):
    """What to run, beyond the workspace itself."""

    label: str | None = Field(default=None, max_length=200)
    #: A Calliope scenario name, or a comma-joined list of override names.
    scenario: str | None = None
    override_dict: dict = Field(default_factory=dict)
    #: Build without solving. Exercises all of the math and needs no solver.
    build_only: bool = False


class RunPatch(BaseModel):
    """The only mutable part of a run."""

    label: str | None = Field(default=None, max_length=200)


def _with_results(record: RunRecord, runs: RunManager, store: ResultStore) -> dict:
    """Adds a results handle to a run that produced one.

    Minting the handle here is what lets the frontend go straight from a
    finished run to its charts, without having to know where the file landed.

    Only for a run that has *finished*. `results.nc` appearing on disk is not the
    same as it being ready to read: the worker writes it, then records the
    outcome, then exits, and until it does the file may still be held open. A
    handle offered any earlier makes the interface open a run's charts the
    instant the file exists, and `calliope.read_netcdf` fails on it.
    """
    payload = record.as_dict()
    if record.has_results and record.status in TERMINAL_STATUSES:
        results_file = runs.run_dir(record.id) / protocol.RESULTS_FILE
        payload["results_handle"] = store.register(results_file)
    else:
        payload["results_handle"] = None
    return payload


def _require_run_dir(run_id: str, runs: RunManager) -> Path:
    try:
        return runs.run_dir(run_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Run not found."
        ) from None


def _snapshot_root(run_id: str, runs: RunManager) -> Path:
    return _require_run_dir(run_id, runs) / protocol.SNAPSHOT_DIR


def _freeze(workspace_path: Path):
    """Returns the hook that snapshots the model into a fresh run directory.

    Passed into `RunManager.start` rather than called by it: `runs` may not import
    `modeldef`, and the freeze has to happen inside `start` to be atomic with
    respect to the run's creation.
    """

    def prepare(run_dir: Path) -> None:
        manifest = write_snapshot(workspace_path, run_dir / protocol.SNAPSHOT_DIR)
        protocol.write_snapshot_manifest(run_dir, manifest)

    return prepare


@router.get("/versions/{id}/runs/")
def list_runs(
    workspace: Workspace = Depends(get_workspace),
    storage: LocalStorage = Depends(get_storage),
    runs: RunManager = Depends(get_runs),
    store: ResultStore = Depends(get_results),
) -> list[dict]:
    """Run history for a workspace, rediscovered from disk.

    Runs outlive the server process, so history survives a restart. Note the
    absent `create=True`: the interface lists runs on load, and listing must not
    be what creates the output directory in a workspace nobody has run anything
    in.
    """
    return [
        _with_results(record, runs, store)
        for record in runs.discover(storage.runs_dir(workspace))
    ]


@router.post("/versions/{id}/runs/", status_code=status.HTTP_201_CREATED)
def create_run(
    body: RunOptions | None = None,
    workspace: Workspace = Depends(get_workspace),
    storage: LocalStorage = Depends(get_storage),
    runs: RunManager = Depends(get_runs),
) -> dict:
    """Starts a run, freezing the model definition into its directory first.

    The body is optional, so a client that sends none still starts a default run.
    """
    options = body or RunOptions()

    model_yaml = find_model_yaml(workspace.path)
    if model_yaml is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No model.yaml found in this workspace.",
        )

    # Checked here rather than discovered by the worker, because a typo would
    # otherwise cost a subprocess start, a Calliope import and a stack trace
    # before anything said "no such scenario".
    if options.scenario:
        known = scenario_names(workspace.path)
        unknown = [
            part
            for part in (piece.strip() for piece in options.scenario.split(","))
            if part and part not in known
        ]
        if unknown:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"No such scenario or override: {', '.join(unknown)}",
            )

    # Old finished runs go before the new one starts, not after it finishes: the
    # worker is the only thing that knows a run completed, and it must not reach
    # back into the server to tidy up.
    storage.prune_runs(workspace)

    record = runs.start(
        storage.runs_dir(workspace, create=True),
        protocol.RunRequest(
            workspace=str(workspace.path),
            model_file=model_yaml.name,
            scenario=options.scenario,
            override_dict=options.override_dict,
            build_only=options.build_only,
            label=(options.label or "").strip() or None,
        ),
        prepare=_freeze(workspace.path),
    )
    return record.as_dict()


@router.get("/runs/{run_id}/")
def get_run(
    run_id: str,
    runs: RunManager = Depends(get_runs),
    store: ResultStore = Depends(get_results),
) -> dict:
    try:
        return _with_results(runs.get(run_id), runs, store)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Run not found."
        ) from None


@router.patch("/runs/{run_id}/")
def rename_run(
    run_id: str,
    body: RunPatch,
    runs: RunManager = Depends(get_runs),
    store: ResultStore = Depends(get_results),
) -> dict:
    """Renames a run.

    Written to `meta.json` rather than back into `request.json`, which is written
    once and never touched again — that is what makes it a trustworthy record of
    what was actually asked for.
    """
    run_dir = _require_run_dir(run_id, runs)
    protocol.write_meta(
        run_dir,
        {
            **protocol.read_meta(run_dir),
            "label": (body.label or "").strip() or None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    return _with_results(runs.get(run_id), runs, store)


@router.delete("/runs/{run_id}/", status_code=status.HTTP_204_NO_CONTENT)
def delete_run(run_id: str, runs: RunManager = Depends(get_runs)) -> None:
    """Removes a run and everything it produced.

    A user who can see what their history costs needs to be able to reclaim it;
    until now nothing in the interface could delete anything.
    """
    _require_run_dir(run_id, runs)
    try:
        runs.delete(run_id)
    except RunStillActive:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This run has not finished. Cancel it first.",
        ) from None


# -- the frozen model definition -----------------------------------------------


@router.get("/runs/{run_id}/snapshot/")
def snapshot_manifest(run_id: str, runs: RunManager = Depends(get_runs)) -> dict:
    """What was frozen when this run started.

    Returns 200 with `available: false` for a run predating snapshots, never 404:
    a 404 here would be indistinguishable from an unknown run id, leaving the
    frontend to guess which of the two it was looking at.
    """
    run_dir = _require_run_dir(run_id, runs)
    manifest = protocol.read_snapshot_manifest(run_dir)
    if manifest is None:
        return {
            "available": False,
            "reason": "This run was made before configuration snapshots existed.",
            "files": [],
            "external": [],
        }
    return {"available": True, "reason": None, **manifest}


@router.get("/runs/{run_id}/files/")
def snapshot_tree(run_id: str, runs: RunManager = Depends(get_runs)) -> list[dict]:
    """The frozen file tree.

    Identical shape to `GET /versions/{id}/files/`, so the explorer is the same
    component pointed at a different base. Empty for a run with no snapshot; a
    run that exists always answers.
    """
    return walk_files(_snapshot_root(run_id, runs))


@router.get("/runs/{run_id}/files/{file_path:path}")
def snapshot_file(
    run_id: str, file_path: str, runs: RunManager = Depends(get_runs)
) -> dict:
    """One frozen file's text. Read-only: history is not editable."""
    path = require_file(resolve_within(_snapshot_root(run_id, runs), file_path))
    return {"content": path.read_text(errors="replace")}


@router.get("/runs/{run_id}/csv/{file_path:path}")
def snapshot_csv(
    run_id: str, file_path: str, runs: RunManager = Depends(get_runs)
) -> dict:
    """A frozen data table, in the grid editor's shape."""
    path = require_file(resolve_within(_snapshot_root(run_id, runs), file_path))
    return parse_csv(path.read_bytes())


@router.get("/runs/{run_id}/import-graph/")
def snapshot_import_graph(run_id: str, runs: RunManager = Depends(get_runs)) -> dict:
    return import_graph(_snapshot_root(run_id, runs))


@router.get("/runs/{run_id}/component-tree/")
def snapshot_component_tree(run_id: str, runs: RunManager = Depends(get_runs)) -> dict:
    return component_tree(_snapshot_root(run_id, runs))


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
