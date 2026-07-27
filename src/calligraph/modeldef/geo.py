"""Node and link geometry read from a model definition.

The same GeoJSON shape `calligraph.results.geo` produces from a solved model, so
one map component can render either: the geography of a model being edited, and
the results of one that has been run.

Reading it here rather than in the browser also fixes something the prototype
got wrong. Calliope 0.7 has no `links:` section — transmission is defined under
`techs:` with `link_from` and `link_to` — so the editor's map, which looked for
one, drew no links at all for any current model.

**A coordinate does not have to be in the YAML.** `latitude` and `longitude` are
ordinary parameters, so a data table with `rows: nodes` can supply them, and real
models do: `examples/model_nld-NUTS3-v1` defines 31 nodes with nothing but
`techs: {}` and gets every position from `tabular-data/scalars/nodes.csv`. Reading
only the `nodes:` section put that model's whole geography off the map — and, worse,
told the user it had no coordinates.
"""

from pathlib import Path
from typing import Any

from calligraph.modeldef.data_tables import data_table_params
from calligraph.modeldef.entities import merged_section, resolve_templates

#: Fraction of the bounding box added as margin.
BOUNDS_PADDING = 0.1

#: Applied when every node sits at the same point, so the map has something to
#: fit to rather than an infinitely small box.
DEGENERATE_PADDING = 1.0


def _coordinate(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


def coordinates_from_tables(base: Path) -> dict[str, dict[str, float]]:
    """Coordinates a data table supplies, per node.

    Only scalars: a `latitude` that varies over time is not a position, and the
    provenance reader marks those with no value at all.
    """
    found: dict[str, dict[str, float]] = {}
    # `Path(base)`, because callers pass a string as readily as a path and
    # `data_table_params` resolves it — the rest of this module tolerates either.
    params = data_table_params(Path(base), "node")["params"]
    for node, parameters in params.items():
        pair = {}
        for key in ("longitude", "latitude"):
            info = parameters.get(key)
            if not isinstance(info, dict) or info.get("time_varying"):
                continue
            number = _coordinate(info.get("value"))
            if number is not None:
                pair[key] = number
        if len(pair) == 2:
            found[str(node)] = pair
    return found


def node_positions(base: Path, nodes: dict | None = None) -> dict[str, list[float]]:
    """`[longitude, latitude]` for every node that has a position at all.

    The YAML wins where it says anything, which is both what Calliope does — it
    unions the `nodes:` section over the table-derived definitions with
    `allow_override=True` — and what the editor needs, since dragging a node
    writes YAML and the map has to show where it was just dropped.

    A node named only by a data table is still a node: `rows: nodes` defines
    them, so leaving them off would hide part of the model.
    """
    nodes = merged_section(base, "nodes") if nodes is None else nodes
    tables = coordinates_from_tables(base)

    names = [str(name) for name in nodes]
    names += [name for name in tables if name not in names]

    positions: dict[str, list[float]] = {}
    for name in names:
        definition = nodes.get(name)
        definition = definition if isinstance(definition, dict) else {}
        fallback = tables.get(name, {})
        longitude = _coordinate(definition.get("longitude"))
        latitude = _coordinate(definition.get("latitude"))
        if longitude is None:
            longitude = fallback.get("longitude")
        if latitude is None:
            latitude = fallback.get("latitude")
        if longitude is None or latitude is None:
            continue
        positions[name] = [longitude, latitude]
    return positions


def nodes_geojson(
    base: Path, nodes: dict | None = None, positions: dict | None = None
) -> dict:
    """Nodes carrying coordinates, as a GeoJSON point collection.

    `positions` is accepted so a caller that needs both collections pays for
    reading the data tables once rather than twice.
    """
    positions = node_positions(base, nodes) if positions is None else positions
    features = [
        {
            "type": "Feature",
            "id": name,
            "geometry": {"type": "Point", "coordinates": position},
            "properties": {"node": name},
        }
        for name, position in positions.items()
    ]
    return {"type": "FeatureCollection", "features": features}


def links_geojson(
    base: Path, nodes: dict | None = None, positions: dict | None = None
) -> dict:
    """Transmission technologies, drawn between the nodes they connect."""
    techs = resolve_templates(
        merged_section(base, "techs"), merged_section(base, "templates")
    )

    positions = node_positions(base, nodes) if positions is None else positions

    features = []
    for name, tech in techs.items():
        source, target = tech.get("link_from"), tech.get("link_to")
        if not source or not target:
            continue
        start, end = positions.get(str(source)), positions.get(str(target))
        if start is None or end is None:
            # A link to a node without coordinates cannot be drawn, which is a
            # normal state for a partly-written model.
            continue

        properties = {"tech": name, "node_from": str(source), "node_to": str(target)}
        color = tech.get("color")
        if isinstance(color, str) and color.startswith("#"):
            properties["color"] = color

        features.append(
            {
                "type": "Feature",
                "id": name,
                "geometry": {"type": "LineString", "coordinates": [start, end]},
                "properties": properties,
            }
        )
    return {"type": "FeatureCollection", "features": features}


def bounds(nodes: dict, padding: float = BOUNDS_PADDING) -> list[list[float]] | None:
    """Bounding box as `[[west, south], [east, north]]`, or None if unmappable."""
    features = nodes.get("features") or []
    if not features:
        return None

    longitudes = [feature["geometry"]["coordinates"][0] for feature in features]
    latitudes = [feature["geometry"]["coordinates"][1] for feature in features]

    west, east = min(longitudes), max(longitudes)
    south, north = min(latitudes), max(latitudes)

    span = max(east - west, north - south)
    margin = span * padding if span else DEGENERATE_PADDING
    return [[west - margin, south - margin], [east + margin, north + margin]]


def tech_colors(base: Path) -> dict[str, str]:
    """Colours declared in the model definition, including via templates."""
    techs = resolve_templates(
        merged_section(base, "techs"), merged_section(base, "templates")
    )
    return {
        name: tech["color"]
        for name, tech in techs.items()
        if isinstance(tech.get("color"), str) and tech["color"].startswith("#")
    }


def geojson(base: Path) -> dict:
    """Everything the map needs for a model definition."""
    nodes = merged_section(base, "nodes")
    positions = node_positions(base, nodes)
    points = nodes_geojson(base, nodes, positions)
    return {
        "nodes": points,
        "links": links_geojson(base, nodes, positions),
        "bounds": bounds(points),
        "colors": tech_colors(base),
    }
