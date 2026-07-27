/**
 * Node and link geometry, built in the browser.
 *
 * The client-side twin of `src/calligraph/modeldef/geo.py`, and it exists for one
 * reason: the editor's map has to show state that is not on disk yet. A node
 * being dragged, a coordinate half-typed, a link that so far exists only in the
 * form — a payload fetched from the server can show none of those, because the
 * server only knows what was last saved.
 *
 * So the map's geometry is derived from whatever the editor currently holds, and
 * the server's payload is used for the *other* half of the picture: the parts of
 * the model defined in files this editor did not load.
 *
 * The rules are the Python module's rules, deliberately: a node without both
 * coordinates is not on the map, a link with an unplaced endpoint cannot be
 * drawn, and the bounding box gets a tenth of its own span as margin. Keep them
 * in step — the two implementations feed the same component.
 */

/** Everything `ModelMap` needs. Matches what both `/geo/` endpoints return. */
export interface GeoPayload {
  nodes: GeoJSON.FeatureCollection;
  links: GeoJSON.FeatureCollection;
  bounds: [[number, number], [number, number]] | null;
  colors?: Record<string, string>;
}

export interface MapNode {
  name: string;
  latitude: number | null;
  longitude: number | null;
  /**
   * Whether this node may be dragged. False for a node defined in a file the
   * editor has not loaded: it can be shown, but moving it would mean writing to
   * a file the editor does not own.
   */
  editable?: boolean;
}

export interface MapLink {
  name: string;
  from: string;
  to: string;
  color?: string;
}

/** Fraction of the bounding box added as margin. `geo.BOUNDS_PADDING`. */
export const BOUNDS_PADDING = 0.1;

/** Used when every node sits at one point, so there is a box to fit. */
export const DEGENERATE_PADDING = 1.0;

function coordinate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/** Nodes carrying both coordinates, as a GeoJSON point collection. */
export function nodesGeojson(nodes: MapNode[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const node of nodes) {
    if (!node.name) continue;
    const longitude = coordinate(node.longitude);
    const latitude = coordinate(node.latitude);
    if (longitude === null || latitude === null) continue;
    features.push({
      type: "Feature",
      id: node.name,
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      properties: { node: node.name, editable: node.editable !== false },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Links whose two endpoints are both placed, as line segments between them. */
export function linksGeojson(
  links: MapLink[],
  positions: Map<string, [number, number]>,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const link of links) {
    if (!link.name) continue;
    const start = positions.get(link.from);
    const end = positions.get(link.to);
    // A link to a node without coordinates cannot be drawn, which is a normal
    // state for a partly-written model.
    if (!start || !end) continue;

    const properties: Record<string, unknown> = {
      tech: link.name,
      node_from: link.from,
      node_to: link.to,
    };
    if (link.color) properties.color = link.color;

    features.push({
      type: "Feature",
      id: link.name,
      geometry: { type: "LineString", coordinates: [start, end] },
      properties,
    });
  }
  return { type: "FeatureCollection", features };
}

/** Bounding box as `[[west, south], [east, north]]`, or null if unmappable. */
export function boundsOf(points: GeoJSON.FeatureCollection): GeoPayload["bounds"] {
  const coordinates = points.features
    .filter((feature) => feature.geometry?.type === "Point")
    .map((feature) => (feature.geometry as GeoJSON.Point).coordinates);
  if (!coordinates.length) return null;

  const longitudes = coordinates.map((pair) => pair[0]);
  const latitudes = coordinates.map((pair) => pair[1]);

  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);

  const span = Math.max(east - west, north - south);
  const margin = span ? span * BOUNDS_PADDING : DEGENERATE_PADDING;
  return [
    [west - margin, south - margin],
    [east + margin, north + margin],
  ];
}

/** Everything the map needs, from the editor's own state. */
export function buildGeo(
  nodes: MapNode[],
  links: MapLink[],
  colors?: Record<string, string>,
): GeoPayload {
  const points = nodesGeojson(nodes);
  const positions = new Map<string, [number, number]>(
    points.features.map((feature) => [
      String(feature.id),
      (feature.geometry as GeoJSON.Point).coordinates as [number, number],
    ]),
  );
  return {
    nodes: points,
    links: linksGeojson(links, positions),
    bounds: boundsOf(points),
    colors,
  };
}

/** The node half of a server payload, back as plain records. */
export function nodesFromFeatures(
  collection: GeoJSON.FeatureCollection | null | undefined,
  editable = false,
): MapNode[] {
  return (collection?.features ?? [])
    .filter((feature) => feature.geometry?.type === "Point")
    .map((feature) => {
      const [longitude, latitude] = (feature.geometry as GeoJSON.Point).coordinates;
      return {
        name: String(feature.properties?.node ?? feature.id ?? ""),
        latitude,
        longitude,
        editable,
      };
    });
}

/** The link half of a server payload, back as plain records. */
export function linksFromFeatures(
  collection: GeoJSON.FeatureCollection | null | undefined,
): MapLink[] {
  return (collection?.features ?? []).map((feature) => ({
    name: String(feature.properties?.tech ?? feature.id ?? ""),
    from: String(feature.properties?.node_from ?? ""),
    to: String(feature.properties?.node_to ?? ""),
    color:
      typeof feature.properties?.color === "string"
        ? feature.properties.color
        : undefined,
  }));
}

/** One parameter as `data-table-params/` reports it. */
export interface TableParam {
  value: unknown;
  time_varying?: boolean;
  /** Which data table it came from, which the forms show and this ignores. */
  source?: string;
}

/**
 * The position a data table supplies for one node, if it supplies one.
 *
 * `latitude` and `longitude` are ordinary parameters, so a table with
 * `rows: nodes` can carry them — and models do: `examples/model_nld-NUTS3-v1`
 * gets 31 of its 37 positions from a CSV and the rest from YAML. Reading only the
 * form's own fields put that model behind the "not all nodes have coordinates"
 * curtain, which was both wrong and unfixable from where it pointed.
 *
 * A time-varying `latitude` is not a position, and the provenance reader gives
 * those no value at all.
 */
export function coordinatesFrom(params: Record<string, TableParam> | undefined): {
  latitude: number | null;
  longitude: number | null;
} {
  const read = (key: string): number | null => {
    const param = params?.[key];
    if (!param || param.time_varying) return null;
    return coordinate(param.value);
  };
  return { latitude: read("latitude"), longitude: read("longitude") };
}

/** Named nodes that cannot go on a map yet, in definition order. */
export function missingCoordinates(nodes: MapNode[]): string[] {
  return nodes
    .filter(
      (node) =>
        node.name &&
        (coordinate(node.latitude) === null || coordinate(node.longitude) === null),
    )
    .map((node) => node.name);
}
