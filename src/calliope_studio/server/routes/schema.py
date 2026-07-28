"""Calliope's own schemas, for the editor's forms and YAML completion.

Two endpoints, because the schemas answer *what* is valid and the editor also has
to know *which* of them applies to the file in front of it. Calliope has four
schemas and a workspace has many files; matching every `.yaml` to the
model-definition one, which is all a single `fileMatch` can do, reports a math
file's every key as unknown.
"""

from fastapi import APIRouter, Depends, HTTPException, status

from calliope_studio.modeldef.filekinds import classify
from calliope_studio.modeldef.schema import calliope_schemas
from calliope_studio.server.deps import get_workspace
from calliope_studio.server.storage import Workspace

router = APIRouter(tags=["schema"])


@router.get("/schema/calliope/")
def get_schema() -> dict:
    """Serves schemas generated from the installed Calliope.

    Generated rather than checked in, so it cannot describe a different version
    from the one that will validate and run the model.
    """
    try:
        return calliope_schemas()
    except Exception as exc:  # pragma: no cover - depends on the Calliope build
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Could not generate schemas from the installed Calliope: {exc}",
        ) from exc


@router.get("/versions/{id}/schema/files/")
def get_file_kinds(workspace: Workspace = Depends(get_workspace)) -> dict:
    """Which Calliope schema describes each YAML file in this workspace.

    Cheap — a YAML walk, with no Calliope import — but not static: adding a file
    to an `import:` list changes its kind, so the editor has to ask again when
    the model changes rather than once at startup.
    """
    return {"kinds": classify(workspace.path)}
