"""Workspaces, presented as projects and versions.

Locally a project is a folder and it contains exactly one version — itself — so
both resources resolve to the same `Workspace` and share its id.
"""

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

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
    try:
        return storage.open(Path(body.path).expanduser()).as_dict()
    except NotADirectoryError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Not a directory: {body.path}",
        ) from None


@router.get("/projects/{id}/")
def get_project(workspace: Workspace = Depends(get_workspace)) -> dict:
    return workspace.as_dict()


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
