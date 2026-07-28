import { computed, ref, watch, type InjectionKey } from "vue";
import { defineStore } from "pinia";

import {
  fetchCatalog,
  fetchGeo,
  type Catalog,
  type Link,
  type ResultQuery,
} from "../api/results";
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
 * Two behaviours here are v0.2.0's `AppState` cascade and are not obvious: the
 * sidebar's several technology sections fold back into one `techs` selector before
 * any query leaves the browser, and changing which variables are on offer
 * re-validates every variable already chosen rather than leaving a selection
 * pointing at something that no longer exists.
 */

/**
 * The sidebar section holding transmission links.
 *
 * Not a dimension of the dataset — it is a slice of `techs` given a section of its
 * own, because on a real model the links outnumber the technologies five to one and
 * drown them: `examples/model_nld-NUTS3-v1` has 41 of them against 10 of everything
 * else. It must never reach the server as a selector key. `filter_selectors` drops
 * keys it does not recognise *silently*, so the failure would not be an error but a
 * `techs` filter quietly missing half its members.
 *
 * It is no longer the exception it was: every base tech now gets a section of its
 * own on the same terms, and `FilterSection.dimension` is the one rule they all
 * follow.
 */
export const TRANSMISSION = "transmission";

/**
 * The base techs given a section each, in the order they are shown.
 *
 * Presentation, so it lives here — v0.2.0 kept the same list in its app layer
 * (`BASE_TECH_ORDERING`) rather than its data layer. `transmission` is absent
 * deliberately: it already has `TRANSMISSION`, whose members come from the
 * catalogue's `links` and carry endpoint labels this list could not give them.
 *
 * Anything Calliope reports that is not here still gets a section, sorted after
 * these — a base tech we have not heard of is not a reason to hide technologies.
 */
const BASE_TECH_ORDER = ["supply", "conversion", "storage", "demand"];

/**
 * Where a technology with no base tech at all goes.
 *
 * Every non-link technology must land in exactly one section. One that landed in
 * none would never be selected, and so would silently vanish from every chart —
 * which is a wrong answer shown to a user, not a missing control.
 */
const OTHER_TECHS = "other";

/** Sections shown first in the filter sidebar; the rest follow alphabetically. */
const DIMENSION_ORDER = ["carriers", "nodes", "techs", TRANSMISSION, "costs"];

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

/**
 * How a chart aggregates, including not at all.
 *
 * `"none"` rather than `null` so it can be a toggle-group value — a toggle group
 * has no way to express "no option", and `keepOne` exists precisely to stop the
 * control ever landing there.
 */
export type SumBy = "none" | "nodes" | "techs";

/**
 * Every sum-by option, always offered in this order.
 *
 * *Always*: an option a variable cannot honour is locked and says why, never
 * removed. A toggle group whose button count changes with the variable reads as a
 * broken control rather than an inapplicable option — which is exactly how it was
 * read the first time it shrank to a lone "No sum".
 */
export const SUM_OPTIONS: SumBy[] = ["none", "nodes", "techs"];

/** How the map encodes a variable. Each channel picks its own. */
export type MapChannel = "size" | "color" | "pie";

/** One section of the filter sidebar, which is all the panel needs to know. */
export interface FilterSection {
  /** Its own name: the key into `selected`, and the suffix of its `data-testid`. */
  name: string;
  /**
   * The dataset dimension it filters, which is not always its name.
   *
   * Equal to `name` for a section that *is* a dimension. For the technology
   * sections — `supply`, `demand`, `transmission`, … — it is `techs`, and
   * `resolvedSelectors` folds them all back into one selector on that. A section
   * whose name reached the server as a selector key would be dropped in silence.
   */
  dimension: string;
  /** Its members, in catalogue order. */
  members: string[];
  /** Display text per member, where it differs from the member itself. */
  labels: Record<string, string>;
}

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
    /**
     * How the time series aggregates.
     *
     * Widened from `"nodes" | "techs"` to include `"none"`, because a variable
     * with neither dimension — `timestep_resolution` is one — would otherwise
     * leave both options locked and the control stuck on a setting it cannot
     * honour. Still defaults to `"nodes"`, so nothing changes on load.
     */
    const sumBy = ref<SumBy>("nodes");
    const timeRange = ref<[string, string] | null>(null);

    /**
     * How the static chart aggregates.
     *
     * Defaults to `"none"`, which is the query this chart always sent — every
     * dimension left standing and the server picking the largest as the index.
     * Summing nodes away is what turns it into model-wide totals by technology,
     * which is one of the first questions anyone asks of a solved model and had
     * no answer here at all.
     */
    const staticSumBy = ref<SumBy>("none");

    /**
     * What the table shows, and how.
     *
     * Its variable comes from the `all` catalogue rather than one of the plotting
     * categories — inputs included, as v0.2.0's table did, since reading a
     * parameter back is half of why anyone opens a table.
     *
     * It defaults to the *original* resolution where the charts default to daily:
     * a chart resamples so a year of hours can be seen at once, and a table exists
     * precisely so the numbers can be read as they are. Resampling by default
     * would be a silent average presented as a value.
     */
    const variableTable = ref<string | null>(null);
    const tableResolution = ref<string>("Original resolution");
    const tableSumBy = ref<SumBy>("none");

    /**
     * Whether the table hides series with nothing in them.
     *
     * The successor to v0.2.0's "Drop N/A values?" switch, mapped onto the query's
     * `drop_zeros`. On by default because that is what the charts show, and
     * because a model defines every variable over the full cross product of its
     * dimensions — turned off on a real model, most of the columns are empty.
     */
    const tableDropEmpty = ref(true);

    /** The variable on each of the map's three encoding channels, or none. */
    const mapVariables = ref<Record<MapChannel, string | null>>({
      size: null,
      color: null,
      pie: null,
    });

    const links = computed<Link[]>(() => catalog.value?.links ?? []);
    const linkTechs = computed(() => links.value.map((link) => link.tech));

    /**
     * `from → to` per link technology.
     *
     * A label shared by two links — parallel links between the same pair — is left
     * out rather than used: ECharts identifies a series by its `name`, so two
     * series called `A → B` would collapse into one legend entry.
     */
    const techLabels = computed<Record<string, string>>(() => {
      const seen = new Map<string, string[]>();
      for (const link of links.value) {
        if (!link.from || !link.to) continue;
        const label = `${link.from} → ${link.to}`;
        seen.set(label, [...(seen.get(label) ?? []), link.tech]);
      }
      const labels: Record<string, string> = {};
      for (const [label, techs] of seen) {
        if (techs.length === 1) labels[techs[0]] = label;
      }
      return labels;
    });

    /** The non-link technologies, in catalogue order. */
    const plainTechs = computed(() => {
      const all = catalog.value?.dimensions.techs ?? [];
      if (!linkTechs.value.length) return all;
      const isLink = new Set(linkTechs.value);
      return all.filter((tech) => !isLink.has(tech));
    });

    /**
     * The non-link technologies bucketed by base tech, in display order.
     *
     * What replaces the single flat `techs` section, so that selecting or clearing
     * every supply technology is one click rather than one per technology — the
     * shape v0.2.0's sidebar had (`_techs_filter`, one checkbox group per base
     * tech, each with its own select-all pair).
     *
     * Empty when the catalogue says nothing about base techs, which is the signal
     * to keep the flat section: a model that states none, and an API process older
     * than the field, both arrive that way. Missing information must not take a
     * working control away — the same reason `sumLock` fails open.
     */
    const techGroups = computed<{ name: string; members: string[] }[]>(() => {
      const baseTechs = catalog.value?.base_techs;
      if (!baseTechs || !Object.keys(baseTechs).length) return [];

      const buckets = new Map<string, string[]>();
      for (const tech of plainTechs.value) {
        // A tech Calliope did not classify still has to be selectable, so it
        // falls to `OTHER_TECHS` rather than out of the sidebar.
        const group = baseTechs[tech] ?? OTHER_TECHS;
        buckets.set(group, [...(buckets.get(group) ?? []), tech]);
      }

      const leading = BASE_TECH_ORDER.filter((name) => buckets.has(name));
      const rest = [...buckets.keys()]
        .filter((name) => !leading.includes(name) && name !== OTHER_TECHS)
        .sort();
      const trailing = buckets.has(OTHER_TECHS) ? [OTHER_TECHS] : [];
      return [...leading, ...rest, ...trailing].map((name) => ({
        name,
        members: buckets.get(name) ?? [],
      }));
    });

    /**
     * The members one section offers, in catalogue order.
     *
     * The only place the technology split lives. `TRANSMISSION` and the base-tech
     * groups are tested before the catalogue, because `catalog.dimensions.supply`
     * does not exist and never will.
     */
    function membersOf(section: string): string[] {
      if (section === TRANSMISSION) return linkTechs.value;
      const group = techGroups.value.find((entry) => entry.name === section);
      if (group) return group.members;
      // The groups replace the flat section rather than sitting beside it; two
      // sections offering the same technology would let one deselect what the
      // other still shows as chosen.
      if (section === "techs") return techGroups.value.length ? [] : plainTechs.value;
      return catalog.value?.dimensions[section] ?? [];
    }

    /** The dataset dimension a section filters — see `FilterSection.dimension`. */
    function dimensionOf(section: string): string {
      if (section === TRANSMISSION) return "techs";
      return techGroups.value.some((entry) => entry.name === section)
        ? "techs"
        : section;
    }

    /** Sections in display order, empty ones dropped. */
    const dimensions = computed(() => {
      const names = Object.keys(catalog.value?.dimensions ?? {});
      if (linkTechs.value.length) names.push(TRANSMISSION);
      names.push(...techGroups.value.map((group) => group.name));
      // One filter covers all of the edge cases: a model with no links has no
      // transmission section, one that is nothing but links has no techs section,
      // and a base tech nothing uses has none either, rather than any of them
      // showing an empty box with All/None in it.
      const present = names.filter((name) => membersOf(name).length > 0);
      // The groups take the place `techs` held, so `TRANSMISSION` still follows
      // them and `costs` still comes last.
      const order = DIMENSION_ORDER.flatMap((name) =>
        name === "techs" && techGroups.value.length
          ? techGroups.value.map((group) => group.name)
          : [name],
      );
      const leading = order.filter((name) => present.includes(name));
      const rest = present.filter((name) => !leading.includes(name)).sort();
      return [...leading, ...rest];
    });

    const sections = computed<FilterSection[]>(() =>
      dimensions.value.map((name) => ({
        name,
        dimension: dimensionOf(name),
        members: membersOf(name),
        labels: name === TRANSMISSION ? techLabels.value : {},
      })),
    );

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
      variableTable.value = pickVariable(variables.all, variableTable.value, "all");

      // The map only offers variables that carry node data, which the catalogue
      // has always computed and nothing used. A channel pointing at something the
      // model no longer has is switched off rather than re-pointed: colour and
      // pie are opt-in, and silently substituting another variable would put a
      // picture on the map that the user never asked for. Size is the exception,
      // because a map with no markers is not a map.
      mapVariables.value = {
        size: pickVariable(variables.static_nodes, mapVariables.value.size, "static_nodes"),
        color: keepVariable(variables.static_nodes, mapVariables.value.color),
        pie: keepVariable(variables.static_nodes, mapVariables.value.pie),
      };
    }

    /** Keeps a channel's variable only if it is still offered. */
    function keepVariable(options: string[], current: string | null) {
      return current && options.includes(current) ? current : null;
    }

    /**
     * Why `option` cannot be applied to `variable`, or "" when it can.
     *
     * The server drops a `sum_by` naming a dimension the array does not have, and
     * drops it *silently*, so an option that cannot work would sit there looking
     * set while changing nothing. That is what this exists to prevent.
     *
     * Note what an unknown variable returns. Not knowing a variable's dimensions
     * is not the same as knowing it has none, and conflating the two removed both
     * sum options from every variable — including ones that could plainly be
     * summed — whenever the catalogue arrived without a `dims` map at all, which
     * is what an API process older than that field serves. Missing information
     * must not take a working control away, so this fails open.
     */
    function sumLock(variable: string | null, option: SumBy): string {
      if (option === "none" || !variable) return "";
      const dims = catalog.value?.variables.dims?.[variable];
      if (!dims) return "";
      return dims.includes(option)
        ? ""
        : `${variable} has no ${option} dimension to sum.`;
    }

    /**
     * Why `variable` cannot be resampled, or "" when it can.
     *
     * `sumLock`'s counterpart, and it exists for the table alone: the time series
     * chart is offered only variables from the `timeseries` catalogue, which all
     * have timesteps by construction, while the table offers everything. The
     * server drops a `resample` on an array with no `timesteps` dimension just as
     * silently as it drops a `sum_by`, so the same rule applies — the option stays
     * and says why it is locked. Fails open on an unknown variable, for the reason
     * `sumLock` does.
     */
    function resampleLock(variable: string | null): string {
      if (!variable) return "";
      const dims = catalog.value?.variables.dims?.[variable];
      if (!dims) return "";
      return dims.includes("timesteps")
        ? ""
        : `${variable} is not a time series, so it cannot be resampled.`;
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
        // worse than a busy one. Built from `dimensions`/`membersOf` rather than
        // from the payload, so it cannot drift from what the sidebar offers.
        selected.value = Object.fromEntries(
          dimensions.value.map((name) => [name, [...membersOf(name)]]),
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
      } finally {
        geoResolved.value = true;
      }
    }

    /**
     * Whether the geography question has been answered, either way.
     *
     * Not "has geography" — this flips false→true exactly once and never back,
     * which is what the results view needs before it can lay its panels out. A
     * splitter reads each panel's `defaultSize` when the panel *registers*, so a
     * map panel that appears a moment later registers into a layout computed
     * without it, and the stored split is silently replaced by a redistribution.
     * Waiting for one answer costs a beat; guessing costs the user's layout.
     */
    const geoResolved = ref(false);

    const hasGeography = computed(
      () => (geo.value?.nodes.features.length ?? 0) > 0,
    );

    function setSelected(dimension: string, members: string[]) {
      selected.value = { ...selected.value, [dimension]: members };
    }

    function selectAll(dimension: string) {
      setSelected(dimension, [...membersOf(dimension)]);
    }

    function selectNone(dimension: string) {
      setSelected(dimension, []);
    }

    /**
     * `selected`, with every section folded onto the dimension it filters.
     *
     * What every query must use — see `TRANSMISSION` for what happens if one does
     * not. The technology sections — `supply`, `demand`, `transmission`, … — merge
     * into one `techs` selector, always ordered by the catalogue rather than by
     * concatenation: an identical selection has to produce an identical query
     * body, or clearing one group reorders the array and `useResultFrame`'s
     * watcher refetches every chart for nothing.
     *
     * Every section goes through the merge, including one whose name already *is*
     * its dimension. Letting those pass straight through instead looks like the
     * obvious shortcut and is wrong: on a model with links but no base techs,
     * `techs` and `transmission` are both sections of the `techs` dimension, and
     * the merged result overwrote the passed-through one — clearing the links
     * emptied the technologies too.
     *
     * Driven by `sections` rather than by the keys of `selected`, so a section that
     * has gone away — the catalogue reloaded, the groups appeared — takes its stale
     * entry with it instead of leaving it in the query.
     *
     * Empty stays empty. Selecting no supply techs and no links means an empty
     * chart, exactly as selecting no technologies did before; "empty means
     * everything" is a rule that belongs to map selection alone.
     */
    const resolvedSelectors = computed<Record<string, string[]>>(() => {
      const merged = new Map<string, Set<string>>();
      for (const section of sections.value) {
        const members = merged.get(section.dimension) ?? new Set<string>();
        for (const member of selected.value[section.name] ?? []) {
          members.add(member);
        }
        merged.set(section.dimension, members);
      }

      const out: Record<string, string[]> = {};
      for (const [dimension, keep] of merged) {
        out[dimension] = (catalog.value?.dimensions[dimension] ?? []).filter(
          (member) => keep.has(member),
        );
      }
      return out;
    });

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
      if (mapNodes.value.length === 0) return resolvedSelectors.value;
      return { ...resolvedSelectors.value, nodes: mapNodes.value };
    });

    /**
     * The sum a query may actually carry.
     *
     * A locked choice becomes no sum rather than travelling and being ignored: the
     * toggle refuses a locked click, but a *variable* can change under a standing
     * choice, and then the chart would be labelled "Sum techs" while showing
     * something else entirely.
     */
    function effectiveSum(variable: string | null, choice: SumBy): SumBy {
      return sumLock(variable, choice) ? "none" : choice;
    }

    /**
     * What each toggle should show as selected.
     *
     * The refs hold what the *user* asked for and the queries use what the
     * variable can honour, and the control has to show the second or it says
     * "Sum nodes" over a chart that is not summing anything. Binding the display
     * rather than rewriting the ref is what lets the preference come back when a
     * variable that can honour it is chosen again.
     */
    const effectiveSumBy = computed(() =>
      effectiveSum(variableTimeseries.value, sumBy.value),
    );
    const effectiveStaticSum = computed(() =>
      effectiveSum(variableStatic.value, staticSumBy.value),
    );
    const effectiveTableSum = computed(() =>
      effectiveSum(variableTable.value, tableSumBy.value),
    );

    /** The resolution the table can actually apply, for the same reason. */
    const effectiveTableResolution = computed(() =>
      resampleLock(variableTable.value) ? "Original resolution" : tableResolution.value,
    );

    const timeseriesQuery = computed<ResultQuery | null>(() => {
      if (!variableTimeseries.value) return null;
      const sum = effectiveSum(variableTimeseries.value, sumBy.value);
      return {
        variable: variableTimeseries.value,
        selectors: effectiveSelectors.value,
        resample: RESOLUTIONS[resolution.value] ?? null,
        time_range: timeRange.value,
        order: plotType.value === "Duration" ? "duration" : "time",
        // Omitted rather than sent as null when there is nothing to sum, the same
        // shape the static chart uses: a body that stays byte-identical is one
        // `useResultFrame`'s deep watch does not refetch for nothing.
        ...(sum === "none" ? {} : { sum_by: sum }),
      };
    });

    const staticQuery = computed<ResultQuery | null>(() => {
      if (!variableStatic.value) return null;
      const sum = effectiveSum(variableStatic.value, staticSumBy.value);
      return {
        variable: variableStatic.value,
        selectors: effectiveSelectors.value,
        ...(sum === "none" ? {} : { sum_by: sum }),
      };
    });

    /**
     * What the table shows.
     *
     * Goes through `effectiveSelectors` like every other query — the sidebar and
     * any map selection both narrow it, which is the point of the table living
     * beside the charts rather than filtering separately. `TRANSMISSION` must
     * never reach the server, and `filter_selectors` drops an unrecognised key in
     * silence, so the failure would be an under-filtered table rather than an
     * error.
     *
     * `drop_zeros` is always sent, unlike `sum_by` and `resample`: it is the one
     * field here whose interesting value is `false`, and a body that omitted it
     * would be asking for the server's default rather than saying what it wants.
     */
    const tableQuery = computed<ResultQuery | null>(() => {
      if (!variableTable.value) return null;
      const sum = effectiveTableSum.value;
      const resample = RESOLUTIONS[effectiveTableResolution.value] ?? null;
      return {
        variable: variableTable.value,
        selectors: effectiveSelectors.value,
        time_range: timeRange.value,
        drop_zeros: tableDropEmpty.value,
        ...(resample ? { resample } : {}),
        ...(sum === "none" ? {} : { sum_by: sum }),
      };
    });

    /**
     * One query per map channel, or null for a channel that is switched off.
     *
     * Each is indexed by node and summed over technologies, so a marker shows how
     * much of its variable sits at that node — except the pie, which needs the
     * technologies kept apart because they are what the wedges are.
     *
     * All three deliberately ignore `mapNodes` — encoding the markers by the
     * selection made on the markers is circular — but still go through
     * `resolvedSelectors`, because the synthetic transmission section must not
     * reach the server from here either.
     */
    function mapQueryFor(channel: MapChannel): ResultQuery | null {
      const variable = mapVariables.value[channel];
      if (!variable) return null;
      return {
        variable,
        selectors: resolvedSelectors.value,
        index: "nodes",
        ...(channel === "pie" ? {} : { sum_by: "techs" }),
      };
    }

    const mapSizeQuery = computed(() => mapQueryFor("size"));
    const mapPieQuery = computed(() => mapQueryFor("pie"));

    /**
     * The colour channel, which a pie switches off.
     *
     * A wedge is coloured by its technology, so a donut has already spent the
     * colour channel on identity; asking for a magnitude on top of it would be a
     * second, invisible encoding. The picker is disabled in the same state, so
     * this only guards against the two being set in either order.
     */
    const mapColorQuery = computed(() =>
      mapVariables.value.pie ? null : mapQueryFor("color"),
    );

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
      geoResolved,
      hasGeography,
      isLoading,
      error,
      selected,
      dimensions,
      sections,
      links,
      linkTechs,
      techLabels,
      techGroups,
      membersOf,
      resolvedSelectors,
      variableTimeseries,
      variableStatic,
      variableTable,
      resolution,
      tableResolution,
      plotType,
      sumBy,
      staticSumBy,
      tableSumBy,
      tableDropEmpty,
      sumLock,
      resampleLock,
      effectiveSumBy,
      effectiveStaticSum,
      effectiveTableSum,
      effectiveTableResolution,
      mapVariables,
      timeRange,
      mapNodes,
      effectiveSelectors,
      timeseriesQuery,
      staticQuery,
      tableQuery,
      mapSizeQuery,
      mapColorQuery,
      mapPieQuery,
      timeseriesKind,
      load,
      setSelected,
      selectAll,
      selectNone,
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
