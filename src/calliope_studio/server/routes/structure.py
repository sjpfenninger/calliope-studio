"""Views across the model's file structure: imports, components, data tables."""

from fastapi import APIRouter, Depends, Query

from calliope_studio.modeldef import geo
from calliope_studio.modeldef.data_tables import data_table_params
from calliope_studio.modeldef.entities import merged_section
from calliope_studio.modeldef.imports import component_tree, import_graph
from calliope_studio.results import colors as results_colors
from calliope_studio.results import geo as resolved_geo
from calliope_studio.server.deps import get_resolver, get_workspace
from calliope_studio.server.resolution import Resolver
from calliope_studio.server.storage import Workspace

router = APIRouter(tags=["structure"])


@router.get("/versions/{id}/component-tree/")
def get_component_tree(workspace: Workspace = Depends(get_workspace)) -> dict:
    return component_tree(workspace.path)


@router.get("/versions/{id}/import-graph/")
def get_import_graph(workspace: Workspace = Depends(get_workspace)) -> dict:
    return import_graph(workspace.path)


@router.get("/versions/{id}/geo/")
def get_geometry(
    workspace: Workspace = Depends(get_workspace),
    resolver: Resolver = Depends(get_resolver),
) -> dict:
    """Node and link geometry for the model definition.

    The same shape the results endpoint returns, so the map component does not
    care whether a model has been solved.

    Geometry comes from the *resolved* model — Calliope's own reading — because
    coordinates and links can come from templates and data tables as well as from
    the `nodes:` and `techs:` sections, and a second implementation of those rules
    is what previously drew an empty map for a model whose positions were all in a
    CSV. `source` says which reading the caller got, and a rebuild in flight is
    reported rather than waited for.
    """
    resolution = resolver.get(workspace)
    if resolution.model is not None:
        payload = resolved_geo.geojson(
            resolution.model,
            colors=results_colors.tech_colors(resolution.model),
            # Which end of a link is which is the one thing the resolved model does
            # not keep; see `modeldef.geo.link_orientation`.
            orientation=geo.link_orientation(workspace.path),
        )
    else:
        payload = geo.geojson(workspace.path)
    return {**payload, **resolution.as_dict()}


@router.get("/versions/{id}/templates/")
def get_templates(workspace: Workspace = Depends(get_workspace)) -> dict:
    """Every template, each resolved against the templates it inherits from.

    The editors show what an entry inherits, and a template inheriting a template
    is ordinary — `examples/model_nld-NUTS3-v1` has `power_lines →
    interest_rate_setter`. Reading the raw `templates:` section per file, as the
    editors used to, showed only the first hop, so half of what a link actually
    inherits was invisible. This is Calliope's own recursive resolution.
    """
    return {"templates": merged_section(workspace.path, "templates")}


@router.get("/versions/{id}/data-table-params/")
def get_data_table_params(
    kind: str = Query("tech", pattern="^(tech|node)$"),
    workspace: Workspace = Depends(get_workspace),
) -> dict:
    return data_table_params(workspace.path, kind)
