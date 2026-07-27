import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

import { KEY_PREFIX } from "../lib/storageKeys";

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

  /**
   * Whether `nodes` and `links` show their list or their map.
   *
   * Both **default to the map**, because both sections are geography and a
   * coordinate pair is a worse way to say where something is than a position on
   * a map. A model whose nodes are not all placed still opens on the map — greyed
   * out, saying so, with a way through to the list — rather than quietly showing
   * something different depending on the state of the file.
   *
   * Here rather than as a `ref` inside the component, because CLAUDE.md's rule
   * that UI state lives in a store exists precisely for this: as a local ref it
   * reset every time the tab was switched away from and back. Per *section*
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
    sectionView,
    setSectionView,
    toggleSectionView,
    newLinkTemplate,
  };
});
