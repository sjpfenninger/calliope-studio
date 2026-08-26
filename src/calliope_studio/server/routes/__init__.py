"""HTTP routes, one module per resource.

URL shapes are inherited from the prototype this frontend came from, so the Vue
app needed no changes when the backend was replaced. A workspace is addressed as
both a project and its single version; phase 3 collapses that.
"""

from fastapi import APIRouter

from calliope_studio.server.routes import (
    browse,
    csv,
    files,
    math,
    overrides,
    projects,
    results,
    runs,
    schema,
    structure,
    validate,
    yaml_sections,
)

api_router = APIRouter(prefix="/api")

for module in (
    projects,
    browse,
    files,
    csv,
    yaml_sections,
    overrides,
    structure,
    validate,
    math,
    runs,
    results,
    schema,
):
    api_router.include_router(module.router)

__all__ = ["api_router"]
