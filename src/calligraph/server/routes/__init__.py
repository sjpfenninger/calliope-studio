"""HTTP routes, one module per resource.

URL shapes are inherited from the prototype this frontend came from, so the Vue
app needed no changes when the backend was replaced. A workspace is addressed as
both a project and its single version; phase 3 collapses that.
"""

from fastapi import APIRouter

from calligraph.server.routes import (
    csv,
    files,
    projects,
    runs,
    schema,
    structure,
    validate,
    yaml_sections,
)

api_router = APIRouter(prefix="/api")

for module in (projects, files, csv, yaml_sections, structure, validate, runs, schema):
    api_router.include_router(module.router)

__all__ = ["api_router"]
