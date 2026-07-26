import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

export type ThemePreference = "system" | "light" | "dark";
export type ThemeMode = "light" | "dark";

const THEME_KEY = "calligraph.theme";
const SPLITTER_KEY = "calligraph.splitter.sizes";

/** Explorer | editor | side panel. Replaced by a 2-panel shell later. */
const DEFAULT_SPLITTER = [20, 55, 25];

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

  return {
    preference,
    mode,
    isDark,
    revision,
    setPreference,
    cycleTheme,
    splitterSizes,
    setSplitterSizes,
  };
});
