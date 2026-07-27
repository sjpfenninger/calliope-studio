"""Calliope's own schemas, for the editor's forms and YAML completion."""

from fastapi import APIRouter, HTTPException, status

from calliope_studio.modeldef.schema import calliope_schemas

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
