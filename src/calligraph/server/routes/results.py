"""Reading a solved model.

A handle addresses a `results.nc`, whether it came from a run in this workspace
or was opened directly. Result data goes out as an Arrow IPC stream; everything
else — what variables exist, geometry, summaries — is JSON, because it is small
and read once.
"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from calligraph.results import frames, geo, summaries
from calligraph.results.catalog import (
    SYNTHETIC_VARIABLES,
    base_tech_members,
    build_catalog,
    dimension_members,
)
from calligraph.results.colors import tech_colors
from calligraph.results.query import Query, reduce_array
from calligraph.results.store import ResultHandle, ResultsNotFound, ResultStore
from calligraph.server.deps import get_results

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
    transmission = base_tech_members(results.model, "transmission")
    variables = build_catalog(results.dataset, transmission_techs=transmission)
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
        "dimensions": dimension_members(results.dataset),
        "transmission_techs": transmission,
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
    return geo.geojson(results.model, colors=tech_colors(results.model))


@router.get("/results/{handle}/summary/")
def summary(results: ResultHandle = Depends(resolve)) -> dict:
    return summaries.summaries(results)
