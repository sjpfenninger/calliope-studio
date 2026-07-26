"""Node and link geometry read from a model definition.

The same GeoJSON shape `calligraph.results.geo` produces from a solved model, so
one map component can render either: the geography of a model being edited, and
the results of one that has been run.

Reading it here rather than in the browser also fixes something the prototype
got wrong. Calliope 0.7 has no `links:` section — transmission is defined under
`techs:` with `link_from` and `link_to` — so the editor's map, which looked for
one, drew no links at all for any current model.
"""

from pathlib import Path
from typing import Any

from calligraph.modeldef.imports import reachable_files
from calligraph.modeldef.yaml_io import load_quietly, to_plain

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


def _merged_sections(base: Path, section: str) -> dict:
    """Collects one top-level section across the whole import graph.

    A model spreads its technologies and nodes over several files; the first
    definition of a name wins, which is how Calliope resolves them too.
    """
    base = Path(base).resolve()
    merged: dict = {}
    for path in reachable_files(base):
        document = load_quietly(path)
        if not isinstance(document, dict):
            continue
        block = document.get(section)
        if not isinstance(block, dict):
            continue
        for name, definition in block.items():
            merged.setdefault(str(name), to_plain(definition) or {})
    return merged


def _resolve_templates(entries: dict, templates: dict) -> dict:
    """Applies `template:` inheritance, one level deep.

    Transmission technologies in the example models put `link_from`/`link_to` on
    the entry but their `base_tech` on a template, so a link is invisible
    without this.
    """
    resolved = {}
    for name, entry in entries.items():
        if not isinstance(entry, dict):
            resolved[name] = {}
            continue
        template_name = entry.get("template")
        template = templates.get(template_name, {}) if template_name else {}
        resolved[name] = {**template, **entry}
    return resolved


def nodes_geojson(base: Path, nodes: dict | None = None) -> dict:
    """Nodes carrying coordinates, as a GeoJSON point collection."""
    nodes = _merged_sections(base, "nodes") if nodes is None else nodes

    features = []
    for name, definition in nodes.items():
        if not isinstance(definition, dict):
            continue
        longitude = _coordinate(definition.get("longitude"))
        latitude = _coordinate(definition.get("latitude"))
        if longitude is None or latitude is None:
            continue
        features.append(
            {
                "type": "Feature",
                "id": name,
                "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
                "properties": {"node": name},
            }
        )
    return {"type": "FeatureCollection", "features": features}


def links_geojson(base: Path, nodes: dict | None = None) -> dict:
    """Transmission technologies, drawn between the nodes they connect."""
    nodes = _merged_sections(base, "nodes") if nodes is None else nodes
    techs = _resolve_templates(
        _merged_sections(base, "techs"), _merged_sections(base, "templates")
    )

    positions = {
        feature["id"]: feature["geometry"]["coordinates"]
        for feature in nodes_geojson(base, nodes)["features"]
    }

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
    techs = _resolve_templates(
        _merged_sections(base, "techs"), _merged_sections(base, "templates")
    )
    return {
        name: tech["color"]
        for name, tech in techs.items()
        if isinstance(tech.get("color"), str) and tech["color"].startswith("#")
    }


def geojson(base: Path) -> dict:
    """Everything the map needs for a model definition."""
    nodes = _merged_sections(base, "nodes")
    points = nodes_geojson(base, nodes)
    return {
        "nodes": points,
        "links": links_geojson(base, nodes),
        "bounds": bounds(points),
        "colors": tech_colors(base),
    }
