import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEGENERATE_PADDING,
  boundsOf,
  buildGeo,
  coordinatesFrom,
  linksFromFeatures,
  missingCoordinates,
  nodesFromFeatures,
  type MapLink,
  type MapNode,
} from "./mapGeo";

/**
 * The rules here are `src/calliope_studio/modeldef/geo.py`'s rules, so these are the
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

describe("coordinatesFrom", () => {
  /**
   * `examples/model_nld-NUTS3-v1` defines its nodes with nothing but `techs: {}`
   * and gets 31 of its 37 positions from a CSV. Judging "has coordinates" by the
   * YAML fields alone put that whole model behind the greyed-out map.
   */
  it("reads a position a data table supplies", () => {
    expect(
      coordinatesFrom({
        latitude: { value: 51.2797, time_varying: false, source: "nodes" },
        longitude: { value: 4.55, time_varying: false, source: "nodes" },
        country_id: { value: "BEL", time_varying: false, source: "nodes" },
      }),
    ).toEqual({ latitude: 51.2797, longitude: 4.55 });
  });

  it("ignores a time-varying one, which is not a position", () => {
    expect(
      coordinatesFrom({ latitude: { value: null, time_varying: true } }),
    ).toEqual({ latitude: null, longitude: null });
  });

  it("copes with a node no table mentions", () => {
    expect(coordinatesFrom(undefined)).toEqual({ latitude: null, longitude: null });
    expect(coordinatesFrom({})).toEqual({ latitude: null, longitude: null });
  });

  it("is a fallback, not an override: the form's own value wins", () => {
    // What NodesEditor does with it — the YAML coordinate has precedence, which
    // is also how Calliope unions the `nodes:` section over its data tables.
    const table = coordinatesFrom({ latitude: { value: 10 }, longitude: { value: 20 } });
    const entry = { latitude: 40, longitude: null };
    expect(entry.latitude ?? table.latitude).toBe(40);
    expect(entry.longitude ?? table.longitude).toBe(20);
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

/**
 * This module against `src/calliope_studio/modeldef/geo.py`, on real models.
 *
 * The two are twins by design — the server can only draw what was last saved,
 * and the point of an editing map is the unsaved state — and until now nothing
 * held them together. Keeping two implementations aligned by eye is the exact
 * failure the "structure and meaning" doctrine is an argument against, and this
 * pair had no `test_resolution_parity` of its own.
 *
 * `tests/fixtures/map_geo.json` is the seam. `tests/test_map_geo_parity.py`
 * writes it from the Python reading of Calliope's two example models and
 * asserts it is current; this reads it back, feeds the node and link records
 * into the builders here, and requires byte-equal geometry out.
 */
describe("parity with modeldef/geo.py", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../tests/fixtures/map_geo.json"),
      "utf8",
    ),
  ) as Record<
    string,
    {
      nodes: GeoJSON.FeatureCollection;
      links: GeoJSON.FeatureCollection;
      bounds: [[number, number], [number, number]] | null;
    }
  >;

  /**
   * `editable` is this side's alone: it says whether a node may be dragged,
   * which is a question about the *editor* and one the server has no view on.
   * Everything else has to match exactly.
   */
  function withoutEditable(collection: GeoJSON.FeatureCollection) {
    return {
      ...collection,
      features: collection.features.map((feature) => {
        const { editable: _editable, ...properties } = (feature.properties ??
          {}) as Record<string, unknown>;
        return { ...feature, properties };
      }),
    };
  }

  it.each(Object.keys(fixture))("reproduces %s's geometry exactly", (model) => {
    const expected = fixture[model];
    const built = buildGeo(
      nodesFromFeatures(expected.nodes),
      linksFromFeatures(expected.links),
    );

    expect(withoutEditable(built.nodes)).toEqual(expected.nodes);
    expect(built.links).toEqual(expected.links);
    expect(built.bounds).toEqual(expected.bounds);
  });

  it("has geometry to compare in the first place", () => {
    // An empty fixture would pass every assertion above without checking one.
    for (const model of Object.keys(fixture)) {
      expect(fixture[model].nodes.features.length).toBeGreaterThan(0);
      expect(fixture[model].links.features.length).toBeGreaterThan(0);
      expect(fixture[model].bounds).not.toBeNull();
    }
  });
});
