import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchCatalog, fetchGeo, type Catalog } from "../api/results";
import { disposeRunSelection, useRunSelection } from "./runSelection";

vi.mock("../api/results", () => ({
  fetchCatalog: vi.fn(),
  fetchGeo: vi.fn(),
}));

const catalogFor = vi.mocked(fetchCatalog);
const geoFor = vi.mocked(fetchGeo);

function catalog(overrides: Partial<Catalog> = {}): Catalog {
  return {
    id: "h",
    name: "national",
    variables: {
      all: ["flow_cap", "flow*"],
      timeseries: ["flow*", "storage"],
      static: ["flow_cap", "cost"],
      static_nodes: ["flow_cap"],
      static_links: ["flow_cap"],
    },
    dimensions: {
      nodes: ["region1", "region2"],
      techs: ["ccgt", "battery"],
      carriers: ["power"],
    },
    links: [],
    colors: {},
    time_extent: null,
    synthetic: {},
    ...overrides,
  };
}

/**
 * The per-handle selection store — the reason run tabs can exist at all.
 *
 * Its predecessor was a singleton holding one handle, so two run tabs would have
 * shared every filter and `load()` would have reset them on each tab switch.
 * Comparing two runs side by side is the point of run tabs, so these are not
 * corner cases: they are the feature.
 */
describe("useRunSelection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    catalogFor.mockReset();
    geoFor.mockReset();
    catalogFor.mockResolvedValue(catalog());
    geoFor.mockResolvedValue({ nodes: { type: "FeatureCollection", features: [] } });
    disposeRunSelection("h1");
    disposeRunSelection("h2");
  });

  it("returns the same store for the same handle", () => {
    // Two panels inside one run tab must not end up filtering different things.
    expect(useRunSelection("h1")).toBe(useRunSelection("h1"));
  });

  it("keeps two handles entirely independent", async () => {
    const first = useRunSelection("h1");
    const second = useRunSelection("h2");
    await Promise.all([first.load(), second.load()]);

    first.plotType = "Duration";
    first.setSelected("techs", ["ccgt"]);
    first.mapNodes = ["region1"];

    expect(second.plotType).toBe("Bar");
    expect(second.selected.techs).toEqual(["ccgt", "battery"]);
    expect(second.mapNodes).toEqual([]);
  });

  it("does not reset another handle's filters when one loads", async () => {
    const first = useRunSelection("h1");
    await first.load();
    first.setSelected("nodes", ["region2"]);

    await useRunSelection("h2").load();

    // The singleton's `load()` reset `selected` wholesale, which is exactly what
    // a tab switch would have triggered.
    expect(first.selected.nodes).toEqual(["region2"]);
  });

  it("is idempotent, so a rebuilt pane keeps the user's filters", async () => {
    const store = useRunSelection("h1");
    await store.load();
    store.setSelected("techs", ["battery"]);

    await store.load();

    expect(catalogFor).toHaveBeenCalledTimes(1);
    expect(store.selected.techs).toEqual(["battery"]);
  });

  it("selects everything on first load", async () => {
    // A chart showing nothing on first open is worse than a busy one.
    const store = useRunSelection("h1");
    await store.load();
    expect(store.selected).toEqual({
      nodes: ["region1", "region2"],
      techs: ["ccgt", "battery"],
      carriers: ["power"],
    });
  });

  /**
   * On `examples/model_nld-NUTS3-v1` 41 of 51 technologies are links, so an
   * undivided `techs` list is unusable. The section is synthetic — the dataset has
   * no `transmission` dimension — which is what most of this pins down.
   */
  describe("the transmission section", () => {
    const linked = () =>
      catalog({
        dimensions: {
          nodes: ["region1", "region2"],
          techs: ["ccgt", "r1_to_r2", "battery", "r2_to_r3"],
          carriers: ["power"],
        },
        links: [
          { tech: "r1_to_r2", from: "r1", to: "r2" },
          { tech: "r2_to_r3", from: "r2", to: "r3" },
        ],
      });

    it("is absent from a model with no links", async () => {
      const store = useRunSelection("h1");
      await store.load();
      expect(store.dimensions).not.toContain("transmission");
    });

    it("partitions the technologies", async () => {
      catalogFor.mockResolvedValue(linked());
      const store = useRunSelection("h1");
      await store.load();

      expect(store.dimensions).toContain("transmission");
      expect(store.membersOf("techs")).toEqual(["ccgt", "battery"]);
      expect(store.membersOf("transmission")).toEqual(["r1_to_r2", "r2_to_r3"]);
    });

    it("selects both sections in full on first load", async () => {
      catalogFor.mockResolvedValue(linked());
      const store = useRunSelection("h1");
      await store.load();

      expect(store.selected.techs).toEqual(["ccgt", "battery"]);
      expect(store.selected.transmission).toEqual(["r1_to_r2", "r2_to_r3"]);
    });

    it("never sends the synthetic section to the server", async () => {
      // `filter_selectors` drops keys it does not know *silently*, so a leak here
      // is not an error but a `techs` filter quietly missing half its members.
      catalogFor.mockResolvedValue(linked());
      const store = useRunSelection("h1");
      await store.load();

      for (const query of [store.timeseriesQuery, store.staticQuery, store.mapQuery]) {
        expect(query?.selectors?.transmission).toBeUndefined();
      }
    });

    it("folds the two sections into one techs selector", async () => {
      catalogFor.mockResolvedValue(linked());
      const store = useRunSelection("h1");
      await store.load();

      // Catalogue order, not techs-then-links: an identical selection has to
      // produce an identical query body or every chart refetches on a toggle.
      expect(store.timeseriesQuery?.selectors?.techs).toEqual([
        "ccgt",
        "r1_to_r2",
        "battery",
        "r2_to_r3",
      ]);
    });

    it("restores catalogue order after a toggle", async () => {
      catalogFor.mockResolvedValue(linked());
      const store = useRunSelection("h1");
      await store.load();

      store.setSelected("transmission", []);
      store.setSelected("transmission", ["r2_to_r3", "r1_to_r2"]);
      expect(store.resolvedSelectors.techs).toEqual([
        "ccgt",
        "r1_to_r2",
        "battery",
        "r2_to_r3",
      ]);
    });

    it("leaves the technologies alone when the links are cleared", async () => {
      catalogFor.mockResolvedValue(linked());
      const store = useRunSelection("h1");
      await store.load();

      store.selectNone("transmission");
      expect(store.resolvedSelectors.techs).toEqual(["ccgt", "battery"]);
    });

    it("selects all of a section without reaching past it", async () => {
      catalogFor.mockResolvedValue(linked());
      const store = useRunSelection("h1");
      await store.load();

      store.selectNone("techs");
      store.selectAll("transmission");
      expect(store.selected.techs).toEqual([]);
      expect(store.selected.transmission).toEqual(["r1_to_r2", "r2_to_r3"]);
    });

    it("labels a link by its endpoints", async () => {
      catalogFor.mockResolvedValue(linked());
      const store = useRunSelection("h1");
      await store.load();
      expect(store.techLabels).toEqual({
        r1_to_r2: "r1 → r2",
        r2_to_r3: "r2 → r3",
      });
    });

    it("leaves an ambiguous label off rather than duplicating it", async () => {
      // ECharts identifies a series by its name, so two series called `r1 → r2`
      // would collapse into one legend entry.
      catalogFor.mockResolvedValue(
        catalog({
          dimensions: { techs: ["a", "b", "c"] },
          links: [
            { tech: "a", from: "r1", to: "r2" },
            { tech: "b", from: "r1", to: "r2" },
            { tech: "c", from: null, to: null },
          ],
        }),
      );
      const store = useRunSelection("h1");
      await store.load();

      expect(store.techLabels).toEqual({});
      // All three are still offered, under their own names.
      expect(store.membersOf("transmission")).toEqual(["a", "b", "c"]);
    });

    it("describes each section once, for the panel", async () => {
      catalogFor.mockResolvedValue(linked());
      const store = useRunSelection("h1");
      await store.load();

      const section = store.sections.find((entry) => entry.name === "transmission");
      expect(section?.members).toEqual(["r1_to_r2", "r2_to_r3"]);
      expect(section?.labels.r1_to_r2).toBe("r1 → r2");
      // Labels belong to the section that has them, not to every section.
      expect(store.sections.find((entry) => entry.name === "techs")?.labels).toEqual({});
    });
  });

  describe("variable revalidation", () => {
    it("prefers the documented default", async () => {
      const store = useRunSelection("h1");
      await store.load();
      expect(store.variableTimeseries).toBe("flow*");
      expect(store.variableStatic).toBe("flow_cap");
    });

    it("re-picks when the chosen variable stops being offered", async () => {
      const store = useRunSelection("h1");
      await store.load();
      store.variableStatic = "cost";

      // A selection pointing at a variable the catalogue no longer has produces
      // an empty chart and no explanation.
      catalogFor.mockResolvedValue(
        catalog({
          variables: {
            all: ["flow_cap"],
            timeseries: ["storage"],
            static: ["flow_cap"],
            static_nodes: [],
            static_links: [],
          },
        }),
      );
      await store.load(true);

      expect(store.variableStatic).toBe("flow_cap");
      expect(store.variableTimeseries).toBe("storage");
    });
  });

  describe("map selection", () => {
    it("means everything when nothing is picked", async () => {
      const store = useRunSelection("h1");
      await store.load();
      // Falls back to the sidebar rather than narrowing to no nodes at all.
      expect(store.effectiveSelectors.nodes).toEqual(["region1", "region2"]);
    });

    it("narrows the charts when nodes are picked", async () => {
      const store = useRunSelection("h1");
      await store.load();
      store.mapNodes = ["region2"];
      expect(store.effectiveSelectors.nodes).toEqual(["region2"]);
    });

    it("does not narrow the map's own query", async () => {
      // The map sizes its markers from every node; narrowing it to the picked
      // ones would make the unpicked ones vanish as soon as you clicked one.
      const store = useRunSelection("h1");
      await store.load();
      store.mapNodes = ["region2"];
      expect(store.mapQuery?.selectors?.nodes).toEqual(["region1", "region2"]);
    });
  });

  describe("queries", () => {
    it("asks for duration order only for a duration curve", async () => {
      const store = useRunSelection("h1");
      await store.load();
      expect(store.timeseriesQuery?.order).toBe("time");

      store.plotType = "Duration";
      expect(store.timeseriesQuery?.order).toBe("duration");
      // A duration curve is a line; it is the ordering that differs.
      expect(store.timeseriesKind).toBe("line");
    });

    it("translates the resolution label into a pandas rule", async () => {
      const store = useRunSelection("h1");
      await store.load();
      store.resolution = "Monthly";
      expect(store.timeseriesQuery?.resample).toBe("1ME");

      store.resolution = "Original resolution";
      expect(store.timeseriesQuery?.resample).toBeNull();
    });
  });

  it("treats a model without coordinates as normal", async () => {
    geoFor.mockRejectedValue(new Error("no geography"));
    const store = useRunSelection("h1");
    await store.load();

    expect(store.geo).toBeNull();
    expect(store.hasGeography).toBe(false);
    // A failed geo lookup must not look like a failed load.
    expect(store.error).toBeNull();
  });
});
