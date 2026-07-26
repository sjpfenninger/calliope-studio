"""Node and link geometry, as GeoJSON.

The v0.2.0 layer projected everything to Web Mercator with `pyproj`, because
Bokeh's tile renderer needed projected coordinates. A web map library does its
own projection and wants raw longitude and latitude, so that dependency is gone.

GeoJSON rather than a frame because it is what the map consumes directly, and
because it carries the per-feature properties — which node, which technology —
alongside the geometry instead of in a parallel structure.
"""

import math
from typing import Any

from calligraph.results.query import filter_selectors

#: Fraction of the bounding box added as margin, so markers at the edge of a
#: model are not flush against the edge of the map.
BOUNDS_PADDING = 0.1


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
    model, selectors: dict | None = None, colors: dict[str, str] | None = None
) -> dict:
    """Transmission links as a GeoJSON line collection.

    A transmission technology appears at exactly the two nodes it connects, so
    its two coordinate pairs are the ends of the line.
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
    features = []
    for tech, group in located.groupby("techs"):
        coordinates = [
            [_finite(row["longitude"]), _finite(row["latitude"])]
            for _, row in group.iterrows()
        ]
        coordinates = [pair for pair in coordinates if None not in pair]
        if len(coordinates) < 2:
            continue
        nodes = group.index.get_level_values("nodes")
        properties = {
            "tech": str(tech),
            "node_from": str(nodes[0]),
            "node_to": str(nodes[1]),
        }
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
        # stretching a model that is wide and flat.
        margin = max(east - west, north - south) * padding
        west, east = west - margin, east + margin
        south, north = south - margin, north + margin

    return [[west, south], [east, north]]


def geojson(model, selectors: dict | None = None, colors: dict | None = None) -> dict:
    """Everything a map needs in one response.

    The same shape `calligraph.modeldef.geo` produces for an unsolved model, so
    one map component renders either.
    """
    return {
        "nodes": nodes_geojson(model, selectors),
        "links": links_geojson(model, selectors, colors),
        "bounds": bounds(model),
        "colors": colors or {},
    }
