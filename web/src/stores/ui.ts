import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

import { KEY_PREFIX } from "../lib/storageKeys";
import {
  DEFAULT_RESULTS_LAYOUT,
  RESULTS_FIGURES,
  defaultGeometries,
  defaultGeometry,
  isGeometry,
  isLayoutId,
  sameGeometry,
  type ResultsFigure,
  type ResultsGeometry,
  type ResultsGroup,
  type ResultsLayoutId,
} from "../lib/resultsLayouts";

export type { ResultsFigure } from "../lib/resultsLayouts";

export type ThemePreference = "system" | "light" | "dark";
export type ThemeMode = "light" | "dark";

/** A structured editor either lists its entries or shows them on a map. */
export type EditorView = "structured" | "map";

/** The two sections that are geography, and so have a map at all. */
export type MappableSection = "nodes" | "links";

const THEME_KEY = `${KEY_PREFIX}theme`;
const SPLITTER_KEY = `${KEY_PREFIX}splitter.sizes`;
const DATA_TABLE_SPLIT_KEY = `${KEY_PREFIX}dataTable.split`;
const MAP_SPLIT_KEY = `${KEY_PREFIX}map.split`;
const RESULTS_LAYOUT_KEY = `${KEY_PREFIX}results.layout`;
const RESULTS_GEOMETRY_KEY = `${KEY_PREFIX}results.geometry`;
const CONFIG_ADVANCED_KEY = `${KEY_PREFIX}config.advanced`;

/** The single-geometry keys this replaced, read once and then removed. */
const LEGACY_RESULTS_SPLIT_KEY = `${KEY_PREFIX}results.split`;
const LEGACY_RESULTS_COLLAPSED_KEY = `${KEY_PREFIX}results.collapsed`;

/** Explorer | editor | side panel. Replaced by a 2-panel shell later. */
const DEFAULT_SPLITTER = [20, 55, 25];

/** Config above, CSV grid below. The grid gets the larger half. */
const DEFAULT_DATA_TABLE_SPLIT = [40, 60];

/** Map above, the selected entry's form below. */
const DEFAULT_MAP_SPLIT = [72, 28];

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * UI chrome state: the colour theme, and panel geometry.
 *
 * The theme is the app's one piece of genuinely global presentation state, and
 * five renderers have to be *told* when it changes, because none of them observe
 * CSS: ECharts and MapLibre paint to canvas, Monaco keeps its own theme registry,
 * AG Grid needs its `color-scheme`, and the document needs the attribute the
 * tokens key off. `revision` is that notification. It increments **after** the
 * attribute is written, so anything watching it reads correct computed styles.
 *
 * Panel geometry lives here too. It was in `localStorage` directly inside
 * `views/EditorView.vue`, which broke the project's own rule that UI state
 * belongs in a Pinia store, and meant two components could not agree about it.
 */
export const useUiStore = defineStore("ui", () => {
  const preference = ref<ThemePreference>(readPreference());
  const systemMode = ref<ThemeMode>(readSystemMode());

  /**
   * Bumped on every theme change. Monotonic rather than a boolean so a consumer
   * can memoise on it — `charts/theme.ts` registers an ECharts theme per
   * revision, which an equality check against the mode could not express when a
   * token changes without the mode doing so.
   */
  const revision = ref(0);

  const mode = computed<ThemeMode>(() =>
    preference.value === "system" ? systemMode.value : preference.value,
  );
  const isDark = computed(() => mode.value === "dark");

  function readPreference(): ThemePreference {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : "system";
  }

  function readSystemMode(): ThemeMode {
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  }

  function setPreference(next: ThemePreference) {
    preference.value = next;
    localStorage.setItem(THEME_KEY, next);
  }

  /** light → dark → system → light. What a single toolbar button cycles. */
  function cycleTheme() {
    setPreference(
      preference.value === "light"
        ? "dark"
        : preference.value === "dark"
          ? "system"
          : "light",
    );
  }

  // `flush: "sync"` matters: the attribute has to land before any watcher on
  // `revision` calls getComputedStyle, or every consumer resolves the *old*
  // colours and the theme change appears to do nothing to the charts.
  watch(
    mode,
    (next) => {
      const root = document.documentElement;
      root.dataset.cgTheme = next;
      // Native scrollbars, form controls and date pickers follow this.
      root.style.colorScheme = next;
      revision.value += 1;
    },
    { immediate: true, flush: "sync" },
  );

  window.matchMedia(DARK_QUERY).addEventListener("change", (event) => {
    systemMode.value = event.matches ? "dark" : "light";
  });

  // ── Panel geometry ───────────────────────────────────────────────────────

  const splitterSizes = ref<number[]>(readSplitter());

  function readSplitter(): number[] {
    try {
      const stored = localStorage.getItem(SPLITTER_KEY);
      if (!stored) return [...DEFAULT_SPLITTER];
      const parsed = JSON.parse(stored) as unknown;
      // Length-checked, because the shell's panel count changes during this
      // migration and restoring a 3-element array into a 2-panel splitter puts
      // one panel at a size it never asked for.
      return Array.isArray(parsed) && parsed.length === DEFAULT_SPLITTER.length
        ? (parsed as number[])
        : [...DEFAULT_SPLITTER];
    } catch {
      return [...DEFAULT_SPLITTER];
    }
  }

  function setSplitterSizes(sizes: number[]) {
    splitterSizes.value = sizes;
    localStorage.setItem(SPLITTER_KEY, JSON.stringify(sizes));
  }

  /**
   * How a single data table divides its configuration from its CSV.
   *
   * Here for the same reason as `sectionView`: as a local ref it would reset on
   * every tab switch, which is the one thing a splitter must not do.
   */
  const dataTableSplit = ref<number[]>(readDataTableSplit());

  function readDataTableSplit(): number[] {
    try {
      const stored = localStorage.getItem(DATA_TABLE_SPLIT_KEY);
      if (!stored) return [...DEFAULT_DATA_TABLE_SPLIT];
      const parsed = JSON.parse(stored) as unknown;
      return Array.isArray(parsed) && parsed.length === DEFAULT_DATA_TABLE_SPLIT.length
        ? (parsed as number[])
        : [...DEFAULT_DATA_TABLE_SPLIT];
    } catch {
      return [...DEFAULT_DATA_TABLE_SPLIT];
    }
  }

  function setDataTableSplit(sizes: number[]) {
    dataTableSplit.value = sizes;
    localStorage.setItem(DATA_TABLE_SPLIT_KEY, JSON.stringify(sizes));
  }

  // ── Geographic editors ───────────────────────────────────────────────────

  /**
   * How an editor's map divides from the form under it.
   *
   * A splitter rather than a pane that grows to fit its contents, and not for
   * taste: a content-sized pane changes height the moment a node is selected,
   * which resizes the map *under the pointer*. Mid-drag that is worse than
   * cosmetic — the node ends up somewhere the user did not put it, because the
   * projection moved between grabbing it and letting go.
   */
  const mapSplit = ref<number[]>(readMapSplit());

  function readMapSplit(): number[] {
    try {
      const stored = localStorage.getItem(MAP_SPLIT_KEY);
      if (!stored) return [...DEFAULT_MAP_SPLIT];
      const parsed = JSON.parse(stored) as unknown;
      return Array.isArray(parsed) && parsed.length === DEFAULT_MAP_SPLIT.length
        ? (parsed as number[])
        : [...DEFAULT_MAP_SPLIT];
    } catch {
      return [...DEFAULT_MAP_SPLIT];
    }
  }

  function setMapSplit(sizes: number[]) {
    mapSplit.value = sizes;
    localStorage.setItem(MAP_SPLIT_KEY, JSON.stringify(sizes));
  }

  // ── The results view's layouts ───────────────────────────────────────────

  /**
   * Which named arrangement the results view is showing.
   *
   * Global rather than per results handle, like the geometry beside it — two run
   * tabs open on the same question want the same shape. Persisted for the reason
   * the collapsed flags always were: it says what the user is working on, not
   * what they did during one visit to a tab.
   */
  const resultsLayout = ref<ResultsLayoutId>(readResultsLayout());

  function readResultsLayout(): ResultsLayoutId {
    const stored = localStorage.getItem(RESULTS_LAYOUT_KEY);
    return isLayoutId(stored) ? stored : DEFAULT_RESULTS_LAYOUT;
  }

  function setResultsLayout(id: ResultsLayoutId) {
    if (!isLayoutId(id) || resultsLayout.value === id) return;
    resultsLayout.value = id;
    localStorage.setItem(RESULTS_LAYOUT_KEY, id);
  }

  /**
   * The sizes and collapsed figures of **each** layout, kept apart.
   *
   * This is the whole fix. There was one geometry before, and the splitter
   * rewrites it on every drag *and* on every collapse-driven redistribution — so
   * folding a figure away destroyed the sizes of the arrangement it was folded
   * out of, and unfolding it never restored them. Giving each layout its own
   * copy means switching between them, in either direction, disturbs nothing.
   */
  const resultsGeometry = ref<Record<ResultsLayoutId, ResultsGeometry>>(
    readResultsGeometry(),
  );

  function readResultsGeometry(): Record<ResultsLayoutId, ResultsGeometry> {
    const geometries = defaultGeometries();
    try {
      const stored = localStorage.getItem(RESULTS_GEOMETRY_KEY);
      if (!stored) return migrateLegacyResultsGeometry(geometries);
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      for (const id of Object.keys(geometries) as ResultsLayoutId[]) {
        // Whole-entry validation: a group handed an array of the wrong length
        // leaves a panel with no size, and reka's answer to that is a
        // redistribution nobody asked for.
        if (isGeometry(parsed?.[id])) geometries[id] = parsed[id];
      }
      return geometries;
    } catch {
      return geometries;
    }
  }

  /**
   * Folds the pre-layout keys into the `stacked` layout, once.
   *
   * `results.split` held `{3: [map, timeseries, static]}` against a flat group of
   * three panels; the same arrangement is now the map against a charts *column*,
   * so the two chart shares are renormalised inside it. Done here rather than in
   * `migrateLegacyStorageKeys`, which renames prefixes and knows nothing about
   * what a value means. The old keys are removed, so this runs at most once per
   * browser — and only when nothing has been written under the new key, so it can
   * never overwrite a layout the user has since set up.
   */
  function migrateLegacyResultsGeometry(
    geometries: Record<ResultsLayoutId, ResultsGeometry>,
  ): Record<ResultsLayoutId, ResultsGeometry> {
    try {
      const split = JSON.parse(
        localStorage.getItem(LEGACY_RESULTS_SPLIT_KEY) ?? "null",
      ) as Record<string, unknown> | null;
      const three = split?.["3"];
      if (Array.isArray(three) && three.length === 3) {
        const [map, timeseries, unchanging] = three as number[];
        const charts = timeseries + unchanging;
        if (charts > 0 && map >= 0) {
          geometries.stacked.sizes.main = [map, 100 - map];
          geometries.stacked.sizes.charts = [
            (timeseries / charts) * 100,
            (unchanging / charts) * 100,
          ];
        }
      }

      const collapsed = JSON.parse(
        localStorage.getItem(LEGACY_RESULTS_COLLAPSED_KEY) ?? "null",
      ) as Record<string, unknown> | null;
      for (const figure of RESULTS_FIGURES) {
        if (typeof collapsed?.[figure] === "boolean") {
          geometries.stacked.collapsed[figure] = collapsed[figure];
        }
      }
    } catch {
      // A corrupt legacy value is not worth reporting: the defaults are right.
    }
    localStorage.removeItem(LEGACY_RESULTS_SPLIT_KEY);
    localStorage.removeItem(LEGACY_RESULTS_COLLAPSED_KEY);
    return geometries;
  }

  /** The geometry of the layout on screen. */
  const resultsGeometryNow = computed<ResultsGeometry>(
    () => resultsGeometry.value[resultsLayout.value],
  );

  /** Whether the layout on screen is still exactly as it ships. */
  const resultsLayoutIsDefault = computed(() =>
    sameGeometry(resultsGeometryNow.value, defaultGeometry(resultsLayout.value)),
  );

  function writeResultsGeometry(next: ResultsGeometry) {
    resultsGeometry.value = { ...resultsGeometry.value, [resultsLayout.value]: next };
    localStorage.setItem(RESULTS_GEOMETRY_KEY, JSON.stringify(resultsGeometry.value));
  }

  /** Records a drag, against the current layout alone. */
  function setResultsSizes(group: ResultsGroup, sizes: number[]) {
    if (sizes.length !== 2) return;
    const current = resultsGeometryNow.value;
    if (current.sizes[group].every((size, index) => size === sizes[index])) return;
    writeResultsGeometry({
      ...current,
      sizes: { ...current.sizes, [group]: [...sizes] },
    });
  }

  function setResultsCollapsed(figure: ResultsFigure, collapsed: boolean) {
    const current = resultsGeometryNow.value;
    if (current.collapsed[figure] === collapsed) return;
    writeResultsGeometry({
      ...current,
      collapsed: { ...current.collapsed, [figure]: collapsed },
    });
  }

  /** Puts the layout on screen back the way it ships. */
  function resetResultsLayout() {
    writeResultsGeometry(defaultGeometry(resultsLayout.value));
  }

  /**
   * Whether `nodes` and `links` show their list or their map.
   *
   * Both **default to the map**, because both sections are geography and a
   * coordinate pair is a worse way to say where something is than a position on
   * a map. A model whose nodes are not all placed still opens on the map — greyed
   * out, saying so, with a way through to the list — rather than quietly showing
   * something different depending on the state of the file.
   *
   * Here rather than as a `ref` inside the component, because the rule that UI
   * state lives in a store exists precisely for this: as a local ref it reset
   * every time the tab was switched away from and back. Per *section*
   * rather than per tab: two files' nodes are still the same kind of thing to
   * look at, and this matches how the toggle behaved before.
   */
  const sectionView = ref<Record<MappableSection, EditorView>>({
    nodes: "map",
    links: "map",
  });

  function setSectionView(section: MappableSection, view: EditorView) {
    sectionView.value[section] = view;
  }

  function toggleSectionView(section: MappableSection) {
    setSectionView(section, sectionView.value[section] === "map" ? "structured" : "map");
  }

  /**
   * Template a link drawn on the map is created from, or null for none.
   *
   * A bare `base_tech: transmission` is not yet a usable technology — it has no
   * carriers and no costs — and in practice a model's links are all variations on
   * one or two templates, so the picker is set once and then every link drawn
   * inherits from it.
   */
  const newLinkTemplate = ref<string | null>(null);

  // ── The config editor's advanced fields ──────────────────────────────────

  /**
   * Which config sections are showing the options a model rarely sets.
   *
   * Keyed by section — `init`, `build`, `solve` — and not one shared flag. It
   * was one, on the argument that "show me everything" is a single decision;
   * but the control that expresses it is a disclosure sitting *inside* a
   * section, and one of those opening the other two reads as a bug however it
   * is justified. A control governs what it is attached to.
   *
   * None of it governs what a model *has* set: a property the file carries is
   * shown whatever this says, which is the whole point of the tier. So the
   * default is closed without hiding anything the user wrote.
   */
  const configAdvanced = ref<Record<string, boolean>>(readConfigAdvanced());

  function readConfigAdvanced(): Record<string, boolean> {
    try {
      const stored = localStorage.getItem(CONFIG_ADVANCED_KEY);
      if (!stored) return {};
      const parsed = JSON.parse(stored) as unknown;
      // The single-flag spelling this replaced wrote "1"/"0", which parse as
      // numbers and land here as "not a record" — so it degrades to closed
      // rather than needing a migration for one boolean.
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, boolean>)
        : {};
    } catch {
      return {};
    }
  }

  function setConfigAdvanced(section: string, open: boolean) {
    configAdvanced.value = { ...configAdvanced.value, [section]: open };
    localStorage.setItem(CONFIG_ADVANCED_KEY, JSON.stringify(configAdvanced.value));
  }

  return {
    preference,
    mode,
    isDark,
    revision,
    setPreference,
    cycleTheme,
    splitterSizes,
    setSplitterSizes,
    dataTableSplit,
    setDataTableSplit,
    mapSplit,
    setMapSplit,
    resultsLayout,
    setResultsLayout,
    resultsGeometry,
    resultsGeometryNow,
    resultsLayoutIsDefault,
    setResultsSizes,
    setResultsCollapsed,
    resetResultsLayout,
    sectionView,
    setSectionView,
    toggleSectionView,
    newLinkTemplate,
    configAdvanced,
    setConfigAdvanced,
  };
});
