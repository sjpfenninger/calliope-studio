"""Validation: one action, two tiers, one envelope.

There used to be two endpoints, and to a user they looked like two settings of
one knob rather than what they are — a millisecond YAML parse and a full Calliope
build that takes seconds to minutes. Deep subsumed syntax in coverage anyway: a
file that will not parse also fails `read_yaml`, just with a worse message and no
line number. So there is one entry point, and it escalates.

The syntax tier runs in-process first. If it finds anything, that is the answer:
spawning a worker to fail the same parse would cost a subprocess to produce a
vaguer version of a problem already located to the line. Only a clean parse is
worth a build.

Both paths return the same keys, so a client can read one shape and poll only
when there is something to poll:

    {"task_id": str | None, "status": ..., "phase": ..., "result": ... | None}
"""

from fastapi import APIRouter, Depends, HTTPException, status

from calliope_studio.modeldef.imports import find_model_yaml
from calliope_studio.modeldef.validate import check_syntax
from calliope_studio.runs import protocol
from calliope_studio.runs.manager import RunManager
from calliope_studio.runs.validate import errors_from_outcome
from calliope_studio.server.deps import get_runs, get_storage, get_workspace
from calliope_studio.server.storage import LocalStorage, Workspace

router = APIRouter(tags=["validate"])


@router.post("/versions/{id}/validate/", status_code=status.HTTP_202_ACCEPTED)
def validate(
    workspace: Workspace = Depends(get_workspace),
    storage: LocalStorage = Depends(get_storage),
    runs: RunManager = Depends(get_runs),
) -> dict:
    """Checks syntax, and starts a build-only run if the syntax is clean.

    Building without solving exercises the whole definition and all of the math
    while needing no solver, which makes it the most thorough check available
    cheaply.
    """
    syntax = check_syntax(workspace.path)
    if syntax["errors"]:
        return {"task_id": None, "status": "done", "phase": "syntax", "result": syntax}

    model_yaml = find_model_yaml(workspace.path)
    if model_yaml is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No model.yaml found in this workspace.",
        )

    # Old attempts go first. A validation leaves nothing worth keeping, and every
    # click used to leave a permanent directory beside the user's model.
    storage.prune_validations()

    record = runs.start(
        storage.validations_dir(),
        protocol.RunRequest(
            workspace=str(workspace.path), model_file=model_yaml.name, build_only=True
        ),
    )
    return {"task_id": record.id, "status": "running", "phase": "build", "result": None}


@router.get("/tasks/{task_id}/")
def task_status(task_id: str, runs: RunManager = Depends(get_runs)) -> dict:
    """Polls a validation's build tier."""
    try:
        run_dir = runs.run_dir(task_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found."
        ) from None

    outcome = protocol.read_outcome(run_dir)
    if outcome is None:
        record = runs.get(task_id)
        if record.status in ("failed", "cancelled"):
            # Terminal without an outcome: killed, or died before it could write
            # one. Report it rather than polling forever.
            return {
                "task_id": task_id,
                "status": "done",
                "phase": "build",
                "result": errors_from_outcome(
                    {"status": record.status, "error": record.error}, "model.yaml"
                ),
            }
        return {
            "task_id": task_id,
            "status": "running",
            "phase": "build",
            "result": None,
        }

    request = protocol.RunRequest.read(run_dir)
    return {
        "task_id": task_id,
        "status": "done",
        "phase": "build",
        "result": errors_from_outcome(outcome, request.model_file),
    }


@router.post("/tasks/{task_id}/cancel/")
async def cancel_task(task_id: str, runs: RunManager = Depends(get_runs)) -> dict:
    """Stops a validation's build by killing its process group.

    A build on a large model takes long enough that leaving no way out of it is
    its own defect. Same mechanism as cancelling a run, because a validation *is*
    a run — Calliope has no interrupt API, so the process group is the only
    lever.
    """
    try:
        await runs.cancel(task_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found."
        ) from None
    return {"task_id": task_id, "status": "done", "phase": "build", "result": None}
