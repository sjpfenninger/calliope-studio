"""Views across the model's file structure: imports, components, data tables."""

from fastapi import APIRouter, Depends, Query

from calligraph.modeldef.data_tables import data_table_params
from calligraph.modeldef.imports import component_tree, import_graph
from calligraph.server.deps import get_workspace
from calligraph.server.storage import Workspace

router = APIRouter(tags=["structure"])


@router.get("/versions/{id}/component-tree/")
def get_component_tree(workspace: Workspace = Depends(get_workspace)) -> dict:
    return component_tree(workspace.path)


@router.get("/versions/{id}/import-graph/")
def get_import_graph(workspace: Workspace = Depends(get_workspace)) -> dict:
    return import_graph(workspace.path)


@router.get("/versions/{id}/data-table-params/")
def get_data_table_params(
    kind: str = Query("tech", pattern="^(tech|node)$"),
    workspace: Workspace = Depends(get_workspace),
) -> dict:
    return data_table_params(workspace.path, kind)
