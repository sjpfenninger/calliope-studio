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

from calliope_studio.modeldef.csv_io import parse_csv
from calliope_studio.modeldef.imports import (
    component_tree,
    find_model_yaml,
    import_graph,
    scenario_catalog,
    scenario_names,
)
from calliope_studio.modeldef.paths import walk_files
from calliope_studio.modeldef.snapshot import write_snapshot
from calliope_studio.results.store import ResultStore
from calliope_studio.runs import protocol
from calliope_studio.runs.manager import (
    TERMINAL_STATUSES,
    RunManager,
    RunRecord,
    RunStillActive,
    WorkerStartError,
)
from calliope_studio.runs.solvers import available_solvers
from calliope_studio.server.deps import (
    get_resolver,
    get_results,
    get_runs,
    get_storage,
    get_workspace,
    require_file,
    require_text,
    require_within_size,
    resolve_within,
)
from calliope_studio.server.resolution import RUN_WORKSPACE_PREFIX, Resolver
from calliope_studio.server.storage import LocalStorage, Workspace

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

    A run whose directory has gone gets no handle rather than an error. History
    is pruned when a run *starts*, so a listing already holding the records can
    be asked about one that was deleted a moment later — and a 500 out of the
    run list empties the whole sidebar over one run that no longer exists.
    """
    payload = record.as_dict()
    payload["results_handle"] = None
    if record.has_results and record.status in TERMINAL_STATUSES:
        try:
            results_file = runs.run_dir(record.id) / protocol.RESULTS_FILE
        except KeyError:
            return payload
        payload["results_handle"] = store.register(results_file)
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


@router.get("/versions/{id}/scenarios/")
def list_scenarios(workspace: Workspace = Depends(get_workspace)) -> dict:
    """What may be passed as `scenario` when starting a run.

    Here rather than with the other structural views because that is what it is:
    the domain of one field of `RunOptions`, read from the same function
    `create_run` below rejects an unknown name with. The picker that consumes
    this cannot offer something the POST would refuse.
    """
    return scenario_catalog(workspace.path)


@router.get("/versions/{id}/solvers/")
def list_solvers(workspace: Workspace = Depends(get_workspace)) -> dict:
    """Solver names Pyomo reports as usable for this model's runs.

    Beside `list_scenarios` for the same reason it is: the domain of one field
    of the run, answered from where the run will happen. Workspace-agnostic
    today — every run uses the interpreter serving this request — but the
    workspace is in the URL because it is what the answer will depend on as soon
    as a run can be pointed at another Calliope, and a global route would have to
    break to say so.

    Suggestions for `config.solve.solver`, which stays free text: Calliope
    accepts any name with a Pyomo interface, and a model is often written
    somewhere other than where it will be solved.
    """
    return {"solvers": available_solvers()}


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
    if workspace.run_retention is not None:
        storage.prune_runs(workspace, keep=workspace.run_retention)

    try:
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
    except WorkerStartError as problem:
        # The interpreter is this server's own, so a failure here is a broken
        # installation rather than a bad request — 500, with the operating
        # system's own complaint, which is the only thing that says what is
        # actually wrong.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(problem)
        ) from problem

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
def delete_run(
    run_id: str,
    runs: RunManager = Depends(get_runs),
    resolver: Resolver = Depends(get_resolver),
) -> None:
    """Removes a run and everything it produced.

    A user who can see what their history costs needs to be able to reclaim it;
    until now nothing in the interface could delete anything.
    """
    _require_run_dir(run_id, runs)
    # Before the files go: the resolver holds the run's frozen tree open if it
    # was ever compared, and on Windows an open `resolved.nc` refuses removal.
    resolver.forget(f"{RUN_WORKSPACE_PREFIX}{run_id}")
    try:
        runs.delete(run_id)
    except RunStillActive:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This run has not finished. Cancel it first.",
        ) from None
    except OSError as problem:
        # A 204 that deleted nothing is worse than an error: the row disappears
        # from the history, the bytes stay on disk, and a refresh brings it back.
        # Reachable on Windows, where anything still holding a file inside the
        # directory refuses the removal outright.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"The run's files could not be removed: {problem}",
        ) from problem


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
    return {"content": require_text(path)}


@router.get("/runs/{run_id}/csv/{file_path:path}")
def snapshot_csv(
    run_id: str, file_path: str, runs: RunManager = Depends(get_runs)
) -> dict:
    """A frozen data table, in the grid editor's shape."""
    path = require_within_size(
        require_file(resolve_within(_snapshot_root(run_id, runs), file_path))
    )
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
            # Every event goes out as JSON, log lines included. They used to go
            # as a bare `data: {msg}`, which lost the level and the logger — so
            # nothing could be coloured or filtered — and, worse, silently
            # truncated any message containing a newline: SSE ends the event at
            # the blank line, and a solver writes its output in multi-line
            # chunks. Encoding escapes the newlines and the problem with them.
            name = event.get("t") if event.get("t") in {"done", "stage"} else "log"
            yield f"event: {name}\ndata: {json.dumps(event)}\n\n"

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
