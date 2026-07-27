import { computed, ref, watch, type InjectionKey } from "vue";
import { defineStore } from "pinia";

import { fetchCatalog, fetchGeo, type Catalog, type ResultQuery } from "../api/results";
import type { GeoPayload } from "../lib/mapGeo";

/**
 * What one set of results is filtered to — one store per results handle.
 *
 * This was a singleton (`stores/selection.ts`) keyed to a single `handle`, which
 * was fine while there was one results screen. The shell opens a run in a tab and
 * several can be open at once, and a singleton would mean two run tabs sharing
 * `selected`, `variableTimeseries`, `timeRange`, `sumBy`, `plotType`,
 * `resolution` and `mapNodes` — and `load()` resetting all of them on every tab
 * switch. Comparing two runs is the *point* of run tabs, so that is not a corner
 * case.
 *
 * A store *factory* memoised by handle, rather than a keyed record inside one
 * store, because:
 *   - the computeds stay real computeds, so caching works and `v-model` on
 *     `store.plotType` still binds — the filter panel and chart controls needed
 *     no logic changes at all;
 *   - `$dispose()` is real teardown, taking the `watch(catalog, …)` with it;
 *   - a keyed record has nowhere to put a per-key watcher.
 *
 * Keyed on **handle**, not run id: it is what every `/api/results/{handle}/…`
 * call needs, it is stable across restarts (a hash of the resolved path), two
 * tabs on the same results file *should* share filters, and a bare `.nc` opened
 * from the command line has a handle but no run.
 *
 * The behaviour below is v0.2.0's `AppState` cascade, and it is not obvious:
 * selecting technologies by base type folds into one combined list, and changing
 * which variables are on offer re-validates every variable already chosen rather
 * than leaving a selection pointing at something that no longer exists.
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

function defineRunSelection(handle: string) {
  return defineStore(`runSelection:${handle}`, () => {
    const catalog = ref<Catalog | null>(null);
    const geo = ref<GeoPayload | null>(null);
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

    /**
     * Loads the catalogue and geography for this handle.
     *
     * Takes no handle: it is fixed for the life of the store, which is the whole
     * reason there is one store per handle. Idempotent, so re-fronting a tab
     * whose pane was torn down does not reset the user's filters.
     */
    async function load(force = false): Promise<void> {
      if (catalog.value && !force) return;
      isLoading.value = true;
      error.value = null;
      try {
        const loaded = await fetchCatalog(handle);
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

      try {
        geo.value = await fetchGeo(handle);
      } catch {
        // A model without coordinates is perfectly normal; the map says so itself.
        geo.value = null;
      }
    }

    const hasGeography = computed(
      () => (geo.value?.nodes.features.length ?? 0) > 0,
    );

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
      geo,
      hasGeography,
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
}

export type RunSelectionStore = ReturnType<ReturnType<typeof defineRunSelection>>;

/**
 * The store for one results handle, created once and reused.
 *
 * Memoised on the *definition*, not the instance: Pinia already returns the same
 * instance for a given id, and holding the definition is what makes two calls
 * from two different components resolve to the same store.
 */
const definitions = new Map<string, ReturnType<typeof defineRunSelection>>();

export function useRunSelection(handle: string): RunSelectionStore {
  let definition = definitions.get(handle);
  if (!definition) {
    definition = defineRunSelection(handle);
    definitions.set(handle, definition);
  }
  return definition();
}

/**
 * Forgets a handle's store entirely.
 *
 * For a results file that has been deleted. Note that an ordinary pane teardown
 * must *not* call this: filters surviving a teardown is the reason re-fronting a
 * run tab restores the view and only refetches the frames.
 */
export function disposeRunSelection(handle: string): void {
  const definition = definitions.get(handle);
  if (!definition) return;
  definition().$dispose();
  definitions.delete(handle);
}

/** Lets the panels inside a run tab reach its store without re-deriving it. */
export const RUN_SELECTION = Symbol("run-selection") as InjectionKey<RunSelectionStore>;
