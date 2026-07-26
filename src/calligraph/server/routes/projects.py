"""Workspaces, presented as projects and versions.

Locally a project is a folder and it contains exactly one version — itself — so
both resources resolve to the same `Workspace` and share its id.
"""

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from calligraph.modeldef.imports import find_model_yaml
from calligraph.server.deps import get_storage, get_workspace
from calligraph.server.storage import LocalStorage, Workspace

router = APIRouter(tags=["projects"])


class OpenWorkspace(BaseModel):
    """Request to open a folder as a workspace."""

    path: str


def _version_of(workspace: Workspace) -> dict:
    return {
        "id": workspace.id,
        "label": workspace.name,
        "files_path": str(workspace.path),
        "created_at": workspace.opened_at.isoformat(),
    }


@router.get("/projects/")
def list_projects(storage: LocalStorage = Depends(get_storage)) -> list[dict]:
    return [workspace.as_dict() for workspace in storage.list()]


@router.post("/projects/", status_code=status.HTTP_201_CREATED)
def open_project(
    body: OpenWorkspace, storage: LocalStorage = Depends(get_storage)
) -> dict:
    """Opens a folder as a workspace.

    Creating a project means pointing at a model folder that already exists;
    scaffolding a new model is `calliope new`, not this.
    """
    path = Path(body.path).expanduser()
    if not path.is_dir():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Not a directory: {body.path}",
        )
    if find_model_yaml(path) is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"No model.yaml in {body.path}. "
                "Create a model there first, for example with `calliope new`."
            ),
        )
    return storage.open(path).as_dict()


@router.get("/projects/{id}/")
def get_project(workspace: Workspace = Depends(get_workspace)) -> dict:
    return workspace.as_dict()


@router.delete("/projects/{id}/", status_code=status.HTTP_204_NO_CONTENT)
def forget_project(
    workspace: Workspace = Depends(get_workspace),
    storage: LocalStorage = Depends(get_storage),
) -> None:
    """Removes a model from the recents list.

    Nothing on disk is touched — the folder, the model and its runs are the
    user's files. This is only a removal from the list of things Calligraph has
    been shown, which previously could not be edited at all: an entry left only
    when its folder was deleted.
    """
    storage.forget(workspace)


class WorkspaceSettings(BaseModel):
    """The settings a workspace has. Currently one.

    `run_retention: null` keeps every run — a reasonable choice for a small
    model and a ruinous one for a large one, which is exactly why it is a
    setting and not a constant.
    """

    run_retention: int | None = None


def _settings_of(workspace: Workspace) -> dict:
    return {"run_retention": workspace.run_retention}


@router.get("/versions/{id}/settings/")
def get_settings(workspace: Workspace = Depends(get_workspace)) -> dict:
    return _settings_of(workspace)


@router.patch("/versions/{id}/settings/")
def update_settings(
    body: WorkspaceSettings,
    workspace: Workspace = Depends(get_workspace),
    storage: LocalStorage = Depends(get_storage),
) -> dict:
    """Changes a workspace's settings.

    Retention applies the next time a run starts, which is when pruning happens.
    Nothing is deleted here: changing a setting should never be the destructive
    act, or lowering the number becomes a mine.
    """
    return _settings_of(storage.set_run_retention(workspace, body.run_retention))


@router.get("/projects/{id}/versions/")
def list_versions(workspace: Workspace = Depends(get_workspace)) -> list[dict]:
    return [_version_of(workspace)]


@router.post("/projects/{id}/versions/", status_code=status.HTTP_201_CREATED)
def create_version(workspace: Workspace = Depends(get_workspace)) -> dict:
    """Not supported locally: a folder is its own single version.

    Versioning a model on disk is what git is for, so inventing a parallel
    mechanism here would be a worse copy of it.
    """
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="A local workspace has a single version. Use git for versioning.",
    )
