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
      dims: {
        flow_cap: ["nodes", "techs", "carriers"],
        cost: ["nodes", "techs", "costs"],
        "flow*": ["nodes", "techs", "carriers", "timesteps"],
        storage: ["nodes", "techs", "timesteps"],
      },
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

      store.mapVariables.pie = "flow_cap";
      for (const query of [
        store.timeseriesQuery,
        store.staticQuery,
        store.mapSizeQuery,
        store.mapPieQuery,
      ]) {
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

  /**
   * One section per base tech, so that clearing every demand technology is one
   * click rather than one per technology — the shape v0.2.0's sidebar had. Note
   * that every test above runs on a catalogue with no `base_techs` at all, which
   * is the fallback path: they are the proof it still works.
   */
  describe("the base-tech sections", () => {
    const typed = (overrides: Partial<Catalog> = {}) =>
      catalog({
        dimensions: {
          nodes: ["region1", "region2"],
          techs: ["ccgt", "r1_to_r2", "battery", "demand_power", "csp"],
          carriers: ["power"],
        },
        links: [{ tech: "r1_to_r2", from: "r1", to: "r2" }],
        base_techs: {
          ccgt: "supply",
          csp: "supply",
          battery: "storage",
          demand_power: "demand",
          r1_to_r2: "transmission",
        },
        ...overrides,
      });

    it("replaces the flat techs section rather than sitting beside it", async () => {
      // Two sections offering the same technology would let one deselect what
      // the other still shows as chosen.
      catalogFor.mockResolvedValue(typed());
      const store = useRunSelection("h1");
      await store.load();

      expect(store.dimensions).not.toContain("techs");
      expect(store.membersOf("techs")).toEqual([]);
      expect(store.selected.techs).toBeUndefined();
    });

    it("orders the groups, and puts them where techs was", async () => {
      catalogFor.mockResolvedValue(typed());
      const store = useRunSelection("h1");
      await store.load();

      expect(store.dimensions).toEqual([
        "carriers",
        "nodes",
        "supply",
        "storage",
        "demand",
        "transmission",
      ]);
    });

    it("keeps the links in their own section, not in a transmission group", async () => {
      // Their section carries endpoint labels, which a base-tech group could not.
      catalogFor.mockResolvedValue(typed());
      const store = useRunSelection("h1");
      await store.load();

      expect(store.techGroups.map((group) => group.name)).toEqual([
        "supply",
        "storage",
        "demand",
      ]);
      expect(store.membersOf("transmission")).toEqual(["r1_to_r2"]);
      expect(store.sections.find((s) => s.name === "transmission")?.labels).toEqual({
        r1_to_r2: "r1 → r2",
      });
    });

    it("offers every technology exactly once, across all of them", async () => {
      // A technology in no section would never be selected, and so would vanish
      // from every chart — a wrong answer, not a missing control.
      catalogFor.mockResolvedValue(typed());
      const store = useRunSelection("h1");
      await store.load();

      const offered = store.sections
        .filter((section) => section.dimension === "techs")
        .flatMap((section) => section.members);
      expect([...offered].sort()).toEqual(
        [...store.catalog!.dimensions.techs].sort(),
      );
      expect(new Set(offered).size).toBe(offered.length);
    });

    it("buckets an unclassified technology rather than dropping it", async () => {
      catalogFor.mockResolvedValue(
        typed({
          dimensions: { techs: ["ccgt", "mystery"] },
          links: [],
          base_techs: { ccgt: "supply" },
        }),
      );
      const store = useRunSelection("h1");
      await store.load();

      expect(store.membersOf("other")).toEqual(["mystery"]);
      // `other` goes last, after every base tech Calliope did name.
      expect(store.dimensions).toEqual(["supply", "other"]);
    });

    it("gives a base tech it has never heard of a section too", async () => {
      catalogFor.mockResolvedValue(
        typed({
          dimensions: { techs: ["ccgt", "odd"] },
          links: [],
          base_techs: { ccgt: "supply", odd: "zeitgeist" },
        }),
      );
      const store = useRunSelection("h1");
      await store.load();
      expect(store.dimensions).toEqual(["supply", "zeitgeist"]);
    });

    it("selects every group in full on first load", async () => {
      catalogFor.mockResolvedValue(typed());
      const store = useRunSelection("h1");
      await store.load();

      expect(store.selected.supply).toEqual(["ccgt", "csp"]);
      expect(store.selected.storage).toEqual(["battery"]);
      expect(store.selected.demand).toEqual(["demand_power"]);
      expect(store.resolvedSelectors.techs).toEqual(
        store.catalog!.dimensions.techs,
      );
    });

    it("clears one type without reaching past it", async () => {
      // The point of the whole change: one click removes every supply tech and
      // leaves the rest of the selection, in catalogue order.
      catalogFor.mockResolvedValue(typed());
      const store = useRunSelection("h1");
      await store.load();

      store.selectNone("supply");
      expect(store.resolvedSelectors.techs).toEqual([
        "r1_to_r2",
        "battery",
        "demand_power",
      ]);

      store.selectAll("supply");
      expect(store.resolvedSelectors.techs).toEqual(
        store.catalog!.dimensions.techs,
      );
    });

    it("never sends a group name to the server", async () => {
      // `filter_selectors` drops keys it does not know *silently*, so a leak here
      // is not an error but a `techs` filter quietly missing most of its members.
      catalogFor.mockResolvedValue(typed());
      const store = useRunSelection("h1");
      await store.load();
      store.mapVariables.pie = "flow_cap";

      const dimensionNames = new Set(Object.keys(store.catalog!.dimensions));
      for (const query of [
        store.timeseriesQuery,
        store.staticQuery,
        store.mapSizeQuery,
        store.mapPieQuery,
      ]) {
        for (const key of Object.keys(query?.selectors ?? {})) {
          expect(dimensionNames.has(key)).toBe(true);
        }
      }
    });

    it("falls back to one flat section when nothing states a base tech", async () => {
      // A model that names none, and an API process older than the field, both
      // arrive this way. Missing information must not take a working control away.
      catalogFor.mockResolvedValue(typed({ base_techs: {} }));
      const store = useRunSelection("h1");
      await store.load();

      expect(store.techGroups).toEqual([]);
      expect(store.dimensions).toContain("techs");
      expect(store.membersOf("techs")).toEqual([
        "ccgt",
        "battery",
        "demand_power",
        "csp",
      ]);
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
            dims: {
              flow_cap: ["nodes", "techs", "carriers"],
              storage: ["nodes", "techs", "timesteps"],
            },
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
      expect(store.mapSizeQuery?.selectors?.nodes).toEqual(["region1", "region2"]);
    });
  });

  describe("map channels", () => {
    it("opens on size only, over the variables carrying node data", async () => {
      const store = useRunSelection("h1");
      await store.load();
      expect(store.mapVariables).toEqual({
        size: "flow_cap",
        color: null,
        pie: null,
      });
      expect(store.mapColorQuery).toBeNull();
      expect(store.mapPieQuery).toBeNull();
    });

    it("keeps technologies apart for a pie and sums them away otherwise", async () => {
      // The wedges *are* the technologies, so summing them out would leave one
      // slice and nothing to see.
      const store = useRunSelection("h1");
      await store.load();
      store.mapVariables.pie = "flow_cap";

      expect(store.mapSizeQuery?.sum_by).toBe("techs");
      expect(store.mapPieQuery?.sum_by).toBeUndefined();
      expect(store.mapPieQuery?.index).toBe("nodes");
    });

    it("gives the colour channel up to a pie", async () => {
      // A wedge is coloured by its technology, so a donut has already spent the
      // colour channel; a magnitude on top of it would be invisible.
      const store = useRunSelection("h1");
      await store.load();
      store.mapVariables.color = "flow_cap";
      expect(store.mapColorQuery?.variable).toBe("flow_cap");

      store.mapVariables.pie = "flow_cap";
      expect(store.mapColorQuery).toBeNull();
    });

    it("switches a channel off rather than re-pointing it", async () => {
      const store = useRunSelection("h1");
      await store.load();
      store.mapVariables.color = "flow_cap";

      catalogFor.mockResolvedValue(
        catalog({
          variables: {
            all: ["cost"],
            timeseries: ["storage"],
            static: ["cost"],
            static_nodes: ["cost"],
            static_links: [],
            dims: { cost: ["nodes", "techs"], storage: ["nodes", "timesteps"] },
          },
        }),
      );
      await store.load(true);

      // Size must land somewhere — a map with no markers is not a map — but
      // substituting a variable onto an opt-in channel would put a picture on
      // the map that nobody asked for.
      expect(store.mapVariables.size).toBe("cost");
      expect(store.mapVariables.color).toBeNull();
    });
  });

  describe("static aggregation", () => {
    it("sends no sum_by by default", async () => {
      // Byte-identical to the body this chart has always sent, so mounting it
      // does not refetch.
      const store = useRunSelection("h1");
      await store.load();
      expect(store.staticQuery).toEqual({
        variable: "flow_cap",
        selectors: store.effectiveSelectors,
      });
    });

    it("sums a dimension when asked", async () => {
      const store = useRunSelection("h1");
      await store.load();
      store.staticSumBy = "nodes";
      expect(store.staticQuery?.sum_by).toBe("nodes");
    });

    it("locks what the variable cannot do, rather than hiding it", async () => {
      const store = useRunSelection("h1");
      await store.load();
      expect(store.sumLock("flow_cap", "nodes")).toBe("");
      expect(store.sumLock("flow_cap", "techs")).toBe("");

      catalogFor.mockResolvedValue(
        catalog({
          variables: {
            all: ["flow_cap"],
            timeseries: ["storage"],
            static: ["flow_cap"],
            static_nodes: ["flow_cap"],
            static_links: [],
            dims: { flow_cap: ["techs"], storage: ["nodes", "timesteps"] },
          },
        }),
      );
      await store.load(true);
      // Named, not merely refused: a greyed control that does not say why reads
      // as broken.
      expect(store.sumLock("flow_cap", "nodes")).toContain("nodes");
      expect(store.sumLock("flow_cap", "techs")).toBe("");
    });

    it("locks nothing when the catalogue reports no dimensions", async () => {
      // The regression this whole mechanism was rewritten for. An API process
      // older than the catalogue's `dims` field sends none, and treating that as
      // "the variable has no dimensions" removed both sum options from every
      // variable — including ones that sum perfectly well.
      const store = useRunSelection("h1");
      catalogFor.mockResolvedValue(
        catalog({
          variables: {
            all: ["flow_cap"],
            timeseries: ["storage"],
            static: ["flow_cap"],
            static_nodes: ["flow_cap"],
            static_links: [],
            dims: undefined as unknown as Record<string, string[]>,
          },
        }),
      );
      await store.load();

      expect(store.sumLock("flow_cap", "nodes")).toBe("");
      expect(store.sumLock("flow_cap", "techs")).toBe("");
      store.staticSumBy = "techs";
      expect(store.staticQuery?.sum_by).toBe("techs");
    });

    it("never locks the do-nothing option", async () => {
      const store = useRunSelection("h1");
      await store.load();
      expect(store.sumLock("total_levelised_cost", "none")).toBe("");
    });

    it("ignores a sum the variable cannot do", async () => {
      // Switching variable must not leave the query asking for a dimension that
      // is not there — the server drops it silently, so the control would look
      // set while doing nothing.
      const store = useRunSelection("h1");
      await store.load();
      store.staticSumBy = "nodes";

      catalogFor.mockResolvedValue(
        catalog({
          variables: {
            all: ["flow_cap"],
            timeseries: ["storage"],
            static: ["flow_cap"],
            static_nodes: [],
            static_links: [],
            dims: { flow_cap: ["techs"], storage: ["nodes", "timesteps"] },
          },
        }),
      );
      await store.load(true);
      expect(store.staticQuery?.sum_by).toBeUndefined();
    });

    it("guards the time series the same way", async () => {
      // This toggle was ungated and had no way off, so on a variable with no
      // `techs` — `unmet_demand` and `unused_supply` are real examples — "Sum
      // techs" was a button that set a state the query could not honour.
      const store = useRunSelection("h1");
      catalogFor.mockResolvedValue(
        catalog({
          variables: {
            all: ["unmet_demand"],
            timeseries: ["unmet_demand"],
            static: ["flow_cap"],
            static_nodes: ["flow_cap"],
            static_links: [],
            dims: {
              unmet_demand: ["nodes", "carriers", "timesteps"],
              flow_cap: ["nodes", "techs", "carriers"],
            },
          },
        }),
      );
      await store.load();

      expect(store.sumLock("unmet_demand", "techs")).toContain("techs");
      expect(store.timeseriesQuery?.sum_by).toBe("nodes");

      store.sumBy = "techs";
      expect(store.timeseriesQuery?.sum_by).toBeUndefined();
    });

    it("still sums nodes on the time series by default", async () => {
      // Widening `sumBy` to carry "none" must not change what the chart asks for
      // on load.
      const store = useRunSelection("h1");
      await store.load();
      expect(store.timeseriesQuery?.sum_by).toBe("nodes");
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
