"""Node and link geometry, as GeoJSON.

The v0.2.0 layer projected everything to Web Mercator with `pyproj`, because
Bokeh's tile renderer needed projected coordinates. A web map library does its
own projection and wants raw longitude and latitude, so that dependency is gone.

GeoJSON rather than a frame because it is what the map consumes directly, and
because it carries the per-feature properties — which node, which technology —
alongside the geometry instead of in a parallel structure.

**This is the only implementation.** It takes a loaded Calliope model and does not
care whether that model has been solved, so the editor's map and the results map
are computed by the same code from the same source of truth. `modeldef.geo` used
to be a second copy of it, working from the YAML, and the two drifted exactly as
far as you would expect: coordinates supplied by a data table were invisible to
one of them, and this one had no degenerate-bounds case. `modeldef.geo` is now the
fallback for a model Calliope cannot read at all.

One thing genuinely cannot come from the resolved model: **which end of a link is
which**. A transmission technology simply exists at two nodes, and `link_from`
survives into `inputs` only when it came from a data table (it does for
`model_nld-NUTS3-v1`, not for `national_scale`, where `_links_to_node_format`
consumes the YAML form). So orientation is passed in by the caller from the
declaration, and falls back to coordinate order.
"""

import math
from typing import Any

from calligraph.results.query import filter_selectors

#: Fraction of the bounding box added as margin, so markers at the edge of a
#: model are not flush against the edge of the map.
BOUNDS_PADDING = 0.1

#: Applied when every node sits at the same point — one node, or several that
#: coincide. Without it the box has zero area and `fitBounds` has nothing to fit.
DEGENERATE_PADDING = 1.0


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def nodes_geojson(model, selectors: dict | None = None) -> dict:
    """Node locations as a GeoJSON point collection."""
    inputs = model.inputs
    if "longitude" not in inputs or "latitude" not in inputs:
        return {"type": "FeatureCollection", "features": []}

    nodes = inputs[["longitude", "latitude"]]
    if selectors:
        nodes = nodes.sel(filter_selectors(nodes, selectors))

    features = []
    for node, row in nodes.to_dataframe().iterrows():
        longitude, latitude = _finite(row["longitude"]), _finite(row["latitude"])
        if longitude is None or latitude is None:
            continue
        features.append(
            {
                "type": "Feature",
                "id": str(node),
                "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
                "properties": {"node": str(node)},
            }
        )
    return {"type": "FeatureCollection", "features": features}


def links_geojson(
    model,
    selectors: dict | None = None,
    colors: dict[str, str] | None = None,
    orientation: dict[str, tuple[str, str]] | None = None,
) -> dict:
    """Transmission links as a GeoJSON line collection.

    A transmission technology appears at exactly the two nodes it connects, so
    its two coordinate pairs are the ends of the line.

    Args:
        model: A loaded Calliope model, solved or not.
        selectors: Narrows to part of the model, for the results view.
        colors: Per-technology colour.
        orientation: `{tech: (from, to)}` as *declared*, which the resolved model
            does not reliably carry. Without it the ends come out in coordinate
            order, which is arbitrary — and wrong for anything that draws
            direction.
    """
    inputs = model.inputs
    required = ("longitude", "latitude", "definition_matrix", "base_tech")
    if any(name not in inputs for name in required):
        return {"type": "FeatureCollection", "features": []}

    if selectors:
        inputs = inputs.sel(filter_selectors(inputs, selectors))

    located = (
        inputs[["longitude", "latitude"]]
        .where(inputs.definition_matrix & inputs.base_tech.isin("transmission"))
        .to_dataframe()
        .droplevel("carriers")
        .dropna()
    )

    colors = colors or {}
    orientation = orientation or {}
    features = []
    for tech, group in located.groupby("techs"):
        # Deduplicated by node: a tech can appear once per carrier, and two rows
        # for the same node produced a zero-length "link" from that node to
        # itself. `groupby(level=..., sort=False)` keeps the dataset's own order.
        placed: dict[str, list[float]] = {}
        for index, row in group.iterrows():
            node = str(index[group.index.names.index("nodes")])
            longitude, latitude = _finite(row["longitude"]), _finite(row["latitude"])
            if longitude is None or latitude is None or node in placed:
                continue
            placed[node] = [longitude, latitude]
        if len(placed) != 2:
            # Not two distinct placed endpoints: nothing to draw, and a line with
            # three or more of them is not a link.
            continue

        ends = list(placed)
        declared = orientation.get(str(tech))
        if declared is not None and set(declared) == set(ends):
            ends = list(declared)

        coordinates = [placed[node] for node in ends]
        properties = {"tech": str(tech), "node_from": ends[0], "node_to": ends[1]}
        if tech in colors:
            properties["color"] = colors[tech]
        features.append(
            {
                "type": "Feature",
                "id": str(tech),
                "geometry": {"type": "LineString", "coordinates": coordinates},
                "properties": properties,
            }
        )
    return {"type": "FeatureCollection", "features": features}


def bounds(model, padding: float = BOUNDS_PADDING) -> list[list[float]] | None:
    """The model's bounding box as `[[west, south], [east, north]]`.

    Returns None when the model has no usable coordinates, which is a normal
    state for a model that simply is not geographic.
    """
    points = nodes_geojson(model)["features"]
    if not points:
        return None

    longitudes = [feature["geometry"]["coordinates"][0] for feature in points]
    latitudes = [feature["geometry"]["coordinates"][1] for feature in points]

    west, east = min(longitudes), max(longitudes)
    south, north = min(latitudes), max(latitudes)

    if padding:
        # One margin from the larger span, so the padding is square rather than
        # stretching a model that is wide and flat. A zero span — one node, or
        # several at the same point — gets a fixed box instead of none at all.
        span = max(east - west, north - south)
        margin = span * padding if span else DEGENERATE_PADDING
        west, east = west - margin, east + margin
        south, north = south - margin, north + margin

    return [[west, south], [east, north]]


def geojson(
    model,
    selectors: dict | None = None,
    colors: dict | None = None,
    orientation: dict[str, tuple[str, str]] | None = None,
) -> dict:
    """Everything a map needs in one response.

    The same shape `calligraph.modeldef.geo` produces from the YAML alone, which is
    what the fallback path serves when a model will not load.
    """
    return {
        "nodes": nodes_geojson(model, selectors),
        "links": links_geojson(model, selectors, colors, orientation),
        "bounds": bounds(model),
        "colors": colors or {},
    }
