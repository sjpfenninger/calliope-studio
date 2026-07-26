"""Validation, in two tiers.

`POST /validate/` is the cheap in-process YAML syntax check. `POST
/validate/deep/` asks Calliope itself, which needs a subprocess and takes long
enough to warrant the accepted-then-poll shape the frontend already implements.
"""

from fastapi import APIRouter, Depends, HTTPException, status

from calligraph.modeldef.imports import find_model_yaml
from calligraph.modeldef.validate import check_syntax
from calligraph.runs import protocol
from calligraph.runs.manager import RunManager
from calligraph.runs.validate import errors_from_outcome
from calligraph.server.deps import get_runs, get_storage, get_workspace
from calligraph.server.storage import LocalStorage, Workspace

router = APIRouter(tags=["validate"])


@router.post("/versions/{id}/validate/")
def validate_syntax(workspace: Workspace = Depends(get_workspace)) -> dict:
    return check_syntax(workspace.path)


@router.post("/versions/{id}/validate/deep/", status_code=status.HTTP_202_ACCEPTED)
def validate_deep(
    workspace: Workspace = Depends(get_workspace),
    storage: LocalStorage = Depends(get_storage),
    runs: RunManager = Depends(get_runs),
) -> dict:
    """Starts a build-only run and returns a task handle to poll.

    Building without solving exercises the whole definition and all of the math
    while needing no solver, which makes it the most thorough check available
    cheaply.
    """
    model_yaml = find_model_yaml(workspace.path)
    if model_yaml is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No model.yaml found in this workspace.",
        )

    record = runs.start(
        storage.validations_dir(workspace),
        protocol.RunRequest(
            workspace=str(workspace.path), model_file=model_yaml.name, build_only=True
        ),
    )
    return {"task_id": record.id}


@router.get("/tasks/{task_id}/")
def task_status(task_id: str, runs: RunManager = Depends(get_runs)) -> dict:
    """Polls a deep-validation task."""
    try:
        run_dir = runs.run_dir(task_id)
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found."
        ) from None

    outcome = protocol.read_outcome(run_dir)
    if outcome is None:
        record = runs.get(task_id)
        if record.status == "failed":
            # Died without writing an outcome; report it rather than polling
            # forever.
            return {
                "status": "done",
                "result": errors_from_outcome(
                    {"status": "failed", "error": record.error}, "model.yaml"
                ),
            }
        return {"status": "running", "result": None}

    request = protocol.RunRequest.read(run_dir)
    return {
        "status": "done",
        "result": errors_from_outcome(outcome, request.model_file),
    }
