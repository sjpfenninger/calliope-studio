"""Describing and running a request for result data.

A `Query` is what a chart owns: change one of its fields and the chart re-fetches
itself. It is deliberately a flat, JSON-shaped object, because it travels as a
request body and is the cache key on both sides of the wire.

All of the reduction happens here rather than in the browser. A single
unresampled hourly variable on a small model is a few hundred thousand values,
and there is no reason to move that to a chart which will draw a few thousand
pixels.
"""

from dataclasses import dataclass, field
from typing import Literal

import xarray as xr

from calligraph.results.catalog import get_array

#: How the index is ordered. `duration` sorts every series independently in
#: descending order, turning a timeseries into a load-duration curve; the index
#: then counts periods rather than naming them.
Order = Literal["time", "duration"]


@dataclass(frozen=True)
class Query:
    """A request for one variable, reduced and shaped for display.

    Attributes:
        variable: Variable name, including synthetic ones such as `flow*`.
        selectors: Dimension name to the members to keep.
        time_range: Optional `(start, end)` applied to `timesteps`.
        resample: Optional pandas offset alias, e.g. `1D`, averaged.
        sum_by: Optional dimension to sum away.
        order: `time` or `duration`.
        index: Dimension to use as the index. Defaults to `timesteps` when
            present, otherwise the largest remaining dimension.
        drop_zeros: Drop series that are entirely zero or missing.
    """

    variable: str
    selectors: dict[str, list[str]] = field(default_factory=dict)
    time_range: tuple[str, str] | None = None
    resample: str | None = None
    sum_by: str | None = None
    order: Order = "time"
    index: str | None = None
    drop_zeros: bool = True


def filter_selectors(
    array: xr.DataArray, selectors: dict, additional_subset: dict | None = None
) -> dict:
    """Reduces `selectors` to what actually applies to `array`.

    Two kinds of thing are dropped rather than raised on, because both arise
    routinely from a selection made against a different model:

    - dimensions the variable does not have — a filter on nodes does not
      constrain a variable that has no nodes;
    - members that no longer exist — a technology removed from the model since
      the selection was made.

    Passing an unknown member through to xarray raises a `KeyError` naming the
    coordinate, which is indistinguishable from a genuinely missing variable by
    the time it reaches a route handler.
    """
    applicable = {}
    for name, members in selectors.items():
        if members is None or name not in array.dims:
            continue
        known = set(array.coords[name].to_index()) if name in array.coords else None
        applicable[name] = [
            member for member in members if known is None or member in known
        ]

    for name, members in (additional_subset or {}).items():
        if name in applicable:
            applicable[name] = [m for m in members if m in applicable[name]]
        else:
            applicable[name] = list(members)
    return applicable


def reduce_array(dataset: xr.Dataset, query: Query) -> xr.DataArray:
    """Applies a query's reductions, returning the array still in xarray form.

    Ordering matters and matches the v0.2.0 behaviour it is verified against:
    selectors, then resampling, then the time range, then the sum.
    """
    array = get_array(dataset, query.variable)
    array = array.sel(filter_selectors(array, query.selectors))

    if query.resample and "timesteps" in array.dims:
        array = array.resample(timesteps=query.resample).mean()

    if query.time_range and "timesteps" in array.dims:
        array = array.sel(timesteps=slice(*query.time_range))

    if query.sum_by and query.sum_by in array.dims:
        array = array.sum(query.sum_by)

    return array


def choose_index(array: xr.DataArray, requested: str | None) -> str | None:
    """Picks the dimension to lay out along the index.

    Timesteps whenever there are any — that is what a chart's x axis wants — and
    otherwise the largest remaining dimension, which puts the most bars on the
    axis and the fewest series in the legend.
    """
    if requested and requested in array.dims:
        return requested
    if "timesteps" in array.dims:
        return "timesteps"
    if not array.dims:
        return None
    return max(array.dims, key=lambda name: array.sizes[name])
