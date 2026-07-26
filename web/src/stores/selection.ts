import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import { fetchCatalog, type Catalog, type ResultQuery } from "../api/results";

/**
 * What the user is currently looking at, and the rules that keep it coherent.
 *
 * Reimplemented from the v0.2.0 `AppState` cascade. The behaviour it encodes is
 * not obvious and is easy to lose: selecting technologies by base type has to
 * fold into one combined list, and changing which variables are on offer has to
 * re-validate every variable already chosen rather than leaving a selection
 * pointing at something that no longer exists.
 */

/** Order in which technology groups are offered, coarsest concept first. */
export const BASE_TECHS = [
  "supply",
  "conversion",
  "storage",
  "demand",
  "transmission",
] as const;

/** Dimensions shown first in the filter sidebar; the rest follow alphabetically. */
const DIMENSION_ORDER = ["carriers", "nodes", "techs", "costs"];

export const RESOLUTIONS: Record<string, string | null> = {
  Monthly: "1ME",
  Weekly: "7D",
  Daily: "1D",
  "Original resolution": null,
};

/** Preferred default per variable category, used when the current one lapses. */
const VARIABLE_DEFAULTS: Record<string, string> = {
  timeseries: "flow*",
  static: "flow_cap",
  static_nodes: "flow_cap",
  static_links: "flow_cap",
  all: "flow_cap",
};

export type PlotType = "Bar" | "Line" | "Area" | "Duration";

export const useSelectionStore = defineStore("selection", () => {
  const handle = ref<string | null>(null);
  const catalog = ref<Catalog | null>(null);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  const selected = ref<Record<string, string[]>>({});
  const variableTimeseries = ref<string | null>(null);
  const variableStatic = ref<string | null>(null);
  const resolution = ref<string>("Daily");
  const plotType = ref<PlotType>("Bar");
  const sumBy = ref<"nodes" | "techs">("nodes");
  const timeRange = ref<[string, string] | null>(null);

  /** Dimensions in display order. */
  const dimensions = computed(() => {
    const names = Object.keys(catalog.value?.dimensions ?? {});
    const leading = DIMENSION_ORDER.filter((name) => names.includes(name));
    const rest = names.filter((name) => !leading.includes(name)).sort();
    return [...leading, ...rest];
  });

  /** Technologies grouped by base type, for the sidebar's grouped controls. */
  const techsByBaseTech = ref<Record<string, string[]>>({});

  function pickVariable(options: string[], current: string | null, category: string) {
    if (current && options.includes(current)) return current;
    const preferred = VARIABLE_DEFAULTS[category];
    if (preferred && options.includes(preferred)) return preferred;
    return options[0] ?? null;
  }

  /** Re-validates variable selections against what the catalogue now offers. */
  function revalidateVariables() {
    const variables = catalog.value?.variables;
    if (!variables) return;
    variableTimeseries.value = pickVariable(
      variables.timeseries,
      variableTimeseries.value,
      "timeseries",
    );
    variableStatic.value = pickVariable(
      variables.static,
      variableStatic.value,
      "static",
    );
  }

  async function load(newHandle: string) {
    handle.value = newHandle;
    isLoading.value = true;
    error.value = null;
    try {
      const loaded = await fetchCatalog(newHandle);
      catalog.value = loaded;

      // Everything starts selected: a chart showing nothing on first open is
      // worse than a busy one.
      selected.value = Object.fromEntries(
        Object.entries(loaded.dimensions).map(([name, members]) => [
          name,
          [...members],
        ]),
      );
      revalidateVariables();
    } catch (caught) {
      error.value = (caught as Error).message ?? String(caught);
      catalog.value = null;
    } finally {
      isLoading.value = false;
    }
  }

  function setSelected(dimension: string, members: string[]) {
    selected.value = { ...selected.value, [dimension]: members };
  }

  function selectAll(dimension: string) {
    setSelected(dimension, [...(catalog.value?.dimensions[dimension] ?? [])]);
  }

  function selectNone(dimension: string) {
    setSelected(dimension, []);
  }

  /** Selects every technology of one base type, keeping the others as they are. */
  function toggleBaseTech(baseTech: string, on: boolean) {
    const members = techsByBaseTech.value[baseTech] ?? [];
    const current = new Set(selected.value.techs ?? []);
    members.forEach((tech) => (on ? current.add(tech) : current.delete(tech)));
    // Preserve catalogue order rather than set-insertion order, so the legend
    // does not reshuffle as the user toggles groups.
    const ordered = (catalog.value?.dimensions.techs ?? []).filter((tech) =>
      current.has(tech),
    );
    setSelected("techs", ordered);
  }

  /** Nodes picked on the map, which narrow the charts further. */
  const mapNodes = ref<string[]>([]);

  /**
   * The selection the charts actually use.
   *
   * Picking nodes on the map narrows to those; picking none falls back to the
   * sidebar, so an empty map selection means "everything" rather than
   * "nothing". v0.2.0 did this through a Bokeh server callback.
   */
  const effectiveSelectors = computed<Record<string, string[]>>(() => {
    if (mapNodes.value.length === 0) return selected.value;
    return { ...selected.value, nodes: mapNodes.value };
  });

  const timeseriesQuery = computed<ResultQuery | null>(() => {
    if (!variableTimeseries.value) return null;
    return {
      variable: variableTimeseries.value,
      selectors: effectiveSelectors.value,
      resample: RESOLUTIONS[resolution.value] ?? null,
      sum_by: sumBy.value,
      time_range: timeRange.value,
      order: plotType.value === "Duration" ? "duration" : "time",
    };
  });

  const staticQuery = computed<ResultQuery | null>(() => {
    if (!variableStatic.value) return null;
    return {
      variable: variableStatic.value,
      selectors: effectiveSelectors.value,
    };
  });

  /**
   * Per-node totals for the map's marker sizes.
   *
   * Indexed by node and summed over technologies, so a marker shows how much of
   * the chosen variable sits at that node.
   */
  const mapQuery = computed<ResultQuery | null>(() => {
    if (!variableStatic.value) return null;
    return {
      variable: variableStatic.value,
      selectors: selected.value,
      index: "nodes",
      sum_by: "techs",
    };
  });

  /** Which chart type the timeseries pane should draw. */
  const timeseriesKind = computed<"bar" | "line" | "area">(() => {
    if (plotType.value === "Bar") return "bar";
    if (plotType.value === "Area") return "area";
    // A duration curve is a line; it is the ordering that differs, and that is
    // settled server-side.
    return "line";
  });

  watch(catalog, revalidateVariables);

  return {
    handle,
    catalog,
    isLoading,
    error,
    selected,
    dimensions,
    techsByBaseTech,
    variableTimeseries,
    variableStatic,
    resolution,
    plotType,
    sumBy,
    timeRange,
    mapNodes,
    effectiveSelectors,
    timeseriesQuery,
    staticQuery,
    mapQuery,
    timeseriesKind,
    load,
    setSelected,
    selectAll,
    selectNone,
    toggleBaseTech,
  };
});
