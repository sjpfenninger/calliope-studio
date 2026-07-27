"""Reading a solved model.

A handle addresses a `results.nc`, whether it came from a run in this workspace
or was opened directly. Result data goes out as an Arrow IPC stream; everything
else — what variables exist, geometry, summaries — is JSON, because it is small
and read once.
"""

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from calliope_studio.results import frames, geo, summaries
from calliope_studio.results.catalog import (
    SYNTHETIC_VARIABLES,
    build_catalog,
    dimension_members,
)
from calliope_studio.results.colors import tech_colors
from calliope_studio.results.links import link_orientation, transmission_links
from calliope_studio.results.query import Query, reduce_array
from calliope_studio.results.store import ResultHandle, ResultsNotFound, ResultStore
from calliope_studio.runs import protocol
from calliope_studio.runs.manager import RunManager
from calliope_studio.server.deps import get_results, get_runs
from calliope_studio.server.storage import workspace_id

router = APIRouter(tags=["results"])

ARROW_STREAM = "application/vnd.apache.arrow.stream"


class QueryBody(BaseModel):
    """A request for one variable, reduced and shaped for display."""

    variable: str
    selectors: dict[str, list[str] | None] = Field(default_factory=dict)
    time_range: tuple[str, str] | None = None
    resample: str | None = None
    sum_by: str | None = None
    order: Literal["time", "duration"] = "time"
    index: str | None = None
    drop_zeros: bool = True

    def to_query(self) -> Query:
        return Query(
            variable=self.variable,
            selectors={k: v for k, v in self.selectors.items() if v is not None},
            time_range=self.time_range,
            resample=self.resample,
            sum_by=self.sum_by,
            order=self.order,
            index=self.index,
            drop_zeros=self.drop_zeros,
        )


def resolve(handle: str, store: ResultStore = Depends(get_results)) -> ResultHandle:
    try:
        return store.get(handle)
    except ResultsNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Results not found."
        ) from None


@router.get("/results/{handle}/catalog/")
def catalog(results: ResultHandle = Depends(resolve)) -> dict:
    """What can be plotted, and the dimensions available to filter it by."""
    dimensions = dimension_members(results.dataset)
    # Ordered by the `techs` coordinate, so the sidebar's two technology sections
    # partition one list and the selector it merges back into keeps that order.
    links = transmission_links(results.model, order=dimensions.get("techs"))
    variables = build_catalog(
        results.dataset, transmission_techs=[link.tech for link in links]
    )
    colors = tech_colors(results.model)

    timesteps = results.dataset.coords.get("timesteps")
    time_extent = (
        [str(timesteps.to_index()[0]), str(timesteps.to_index()[-1])]
        if timesteps is not None and timesteps.size
        else None
    )

    return {
        "id": results.id,
        "name": results.name,
        "variables": variables.as_dict(),
        "dimensions": dimensions,
        # `dimensions.techs` deliberately still holds every technology: which of
        # them are links is presentation, and the merged selector needs the whole
        # list to re-order against.
        "links": [link.as_dict() for link in links],
        "colors": colors,
        "time_extent": time_extent,
        "synthetic": {
            name: variable.title for name, variable in SYNTHETIC_VARIABLES.items()
        },
    }


@router.post("/results/{handle}/frame/")
def frame(
    body: QueryBody, results: ResultHandle = Depends(resolve)
) -> StreamingResponse:
    """Result data as a wide-by-series Arrow IPC stream.

    One index column and one float column per series, with the coordinates
    identifying each series in its field metadata. Batches are written as they
    are produced so a chart can paint before the whole frame has arrived.
    """
    query = body.to_query()
    # Checked explicitly rather than by catching KeyError, which xarray also
    # raises for coordinate problems — blaming the variable for those produced
    # a flatly wrong error message.
    if (
        query.variable not in results.dataset
        and query.variable not in SYNTHETIC_VARIABLES
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No such variable: {query.variable}",
        )
    array = reduce_array(results.dataset, query)

    table = frames.build_table(array, query, colors=tech_colors(results.model))
    return StreamingResponse(
        frames.stream_ipc(table),
        media_type=ARROW_STREAM,
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/results/{handle}/geo/")
def geometry(results: ResultHandle = Depends(resolve)) -> dict:
    """Node and link geometry as GeoJSON, in longitude and latitude."""
    return geo.geojson(
        results.model,
        colors=tech_colors(results.model),
        # Without this the ends come out in coordinate order, which reverses 6 of
        # `model_nld-NUTS3-v1`'s 41 links. The editor's map has always passed its
        # own; this is the same answer, read from the model rather than the files,
        # because a `.nc` opened from the command line has no workspace to read.
        orientation=link_orientation(results.model),
    )


@router.get("/results/{handle}/summary/")
def summary(results: ResultHandle = Depends(resolve)) -> dict:
    return summaries.summaries(results)


@router.get("/results/{handle}/source/")
def source(
    handle: str,
    store: ResultStore = Depends(get_results),
    runs: RunManager = Depends(get_runs),
) -> dict:
    """Where these results came from.

    The handle-to-run relationship was one-way and lossy: given a handle you could
    not recover the run, the workspace or any metadata, and `catalog` reports a
    `name` that is the file stem — so every run's results were called "results".

    Derived from the file's location rather than recorded when the handle was
    minted, because a mapping held in memory is lost on every restart and the
    location is authoritative anyway. A `.nc` sitting beside a `request.json` is a
    run's output; anything else was opened directly.

    Deliberately a separate endpoint rather than more fields on `catalog`, which is
    the hot path a chart waits on.
    """
    path = store.path_for(handle)
    if path is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Results not found."
        )

    run_dir = path.parent
    if (run_dir / protocol.REQUEST_FILE).is_file():
        try:
            record = runs.get(run_dir.name)
        except KeyError:
            record = None
        if record is not None:
            workspace = Path(record.workspace) if record.workspace else None
            return {
                "kind": "run",
                "path": str(path),
                "run_id": record.id,
                "label": record.label,
                "scenario": record.scenario,
                "created_at": record.created_at,
                "workspace_path": str(workspace) if workspace else None,
                "workspace_id": workspace_id(workspace) if workspace else None,
            }

    return {
        "kind": "file",
        "path": str(path),
        "run_id": None,
        "label": None,
        "scenario": None,
        "created_at": None,
        "workspace_path": None,
        "workspace_id": None,
    }
