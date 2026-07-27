import { describe, expect, it } from "vitest";

import {
  DEGENERATE_PADDING,
  boundsOf,
  buildGeo,
  linksFromFeatures,
  missingCoordinates,
  nodesFromFeatures,
  type MapLink,
  type MapNode,
} from "./mapGeo";

/**
 * The rules here are `src/calligraph/modeldef/geo.py`'s rules, so these are the
 * frontend counterparts of `tests/test_modeldef_geo.py`. Where the two disagree,
 * the same model draws differently before and after a save.
 */

// The example model's geography, as the editor holds it.
const NODES: MapNode[] = [
  { name: "region1", latitude: 40, longitude: -2 },
  { name: "region2", latitude: 40, longitude: -8 },
  { name: "region1_1", latitude: 41, longitude: -2 },
];

const LINKS: MapLink[] = [
  { name: "region1_to_region2", from: "region1", to: "region2", color: "#8465A9" },
  { name: "region1_to_region1_1", from: "region1", to: "region1_1" },
];

describe("buildGeo", () => {
  it("draws a point per placed node, keyed by name", () => {
    const geo = buildGeo(NODES, LINKS);
    expect(geo.nodes.features.map((feature) => feature.id)).toEqual([
      "region1",
      "region2",
      "region1_1",
    ]);
    expect(geo.nodes.features[0]).toMatchObject({
      geometry: { type: "Point", coordinates: [-2, 40] },
      properties: { node: "region1", editable: true },
    });
  });

  it("leaves out a node missing either coordinate", () => {
    const geo = buildGeo([...NODES, { name: "nowhere", latitude: 5, longitude: null }], []);
    expect(geo.nodes.features.map((feature) => feature.id)).not.toContain("nowhere");
  });

  it("keeps a coordinate of zero", () => {
    const geo = buildGeo([{ name: "origin", latitude: 0, longitude: 0 }], []);
    expect(geo.nodes.features).toHaveLength(1);
  });

  it("draws a link between its endpoints, carrying its identity", () => {
    const geo = buildGeo(NODES, LINKS);
    expect(geo.links.features[0]).toMatchObject({
      id: "region1_to_region2",
      geometry: { type: "LineString", coordinates: [[-2, 40], [-8, 40]] },
      properties: {
        tech: "region1_to_region2",
        node_from: "region1",
        node_to: "region2",
        color: "#8465A9",
      },
    });
  });

  it("omits colour rather than writing an empty one", () => {
    const geo = buildGeo(NODES, LINKS);
    expect(geo.links.features[1].properties).not.toHaveProperty("color");
  });

  it("drops a link whose endpoint is not placed", () => {
    const links = [...LINKS, { name: "dangling", from: "region1", to: "region9" }];
    const geo = buildGeo(NODES, links);
    expect(geo.links.features.map((feature) => feature.id)).not.toContain("dangling");
  });

  it("marks nodes the editor does not own as unmovable", () => {
    const geo = buildGeo([{ ...NODES[0], editable: false }], []);
    expect(geo.nodes.features[0].properties?.editable).toBe(false);
  });

  it("skips unnamed entries, which is what a half-added node is", () => {
    const geo = buildGeo([{ name: "", latitude: 1, longitude: 1 }], []);
    expect(geo.nodes.features).toHaveLength(0);
  });
});

describe("boundsOf", () => {
  it("adds a tenth of the larger span as margin", () => {
    // Spans 6° of longitude and 1° of latitude, so the margin is 0.6 both ways.
    const bounds = boundsOf(buildGeo(NODES, []).nodes);
    expect(bounds).toEqual([
      [-8.6, 39.4],
      [-1.4, 41.6],
    ]);
  });

  it("gives a single point a box to fit", () => {
    const bounds = boundsOf(buildGeo([{ name: "one", latitude: 10, longitude: 5 }], []).nodes);
    expect(bounds).toEqual([
      [5 - DEGENERATE_PADDING, 10 - DEGENERATE_PADDING],
      [5 + DEGENERATE_PADDING, 10 + DEGENERATE_PADDING],
    ]);
  });

  it("is null when there is nothing to fit", () => {
    expect(boundsOf({ type: "FeatureCollection", features: [] })).toBeNull();
  });
});

describe("reading a server payload back", () => {
  it("round-trips nodes", () => {
    const built = buildGeo(NODES, LINKS);
    expect(nodesFromFeatures(built.nodes)).toEqual(
      NODES.map((node) => ({ ...node, editable: false })),
    );
  });

  it("round-trips links", () => {
    const built = buildGeo(NODES, LINKS);
    expect(linksFromFeatures(built.links)).toEqual([
      { name: "region1_to_region2", from: "region1", to: "region2", color: "#8465A9" },
      { name: "region1_to_region1_1", from: "region1", to: "region1_1", color: undefined },
    ]);
  });

  it("tolerates nothing at all", () => {
    expect(nodesFromFeatures(null)).toEqual([]);
    expect(linksFromFeatures(undefined)).toEqual([]);
  });
});

describe("missingCoordinates", () => {
  it("names the nodes that cannot go on a map", () => {
    expect(
      missingCoordinates([
        ...NODES,
        { name: "half", latitude: 40, longitude: null },
        { name: "none", latitude: null, longitude: null },
      ]),
    ).toEqual(["half", "none"]);
  });

  it("is empty for a fully placed model", () => {
    expect(missingCoordinates(NODES)).toEqual([]);
  });
});
