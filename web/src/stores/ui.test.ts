import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUiStore } from "./ui";

/**
 * The theme store, which is the only thing that ever writes `data-cg-theme`.
 *
 * Worth testing because dark mode has never worked in this app: three unrelated
 * switches existed (`tokens.css` styling `[data-cg-theme]`, `charts/theme.ts`
 * reading it, PrimeVue configured for a `.dark-mode` class) and nothing drove any
 * of them. These tests pin the contract every renderer now depends on.
 */

/** A controllable `prefers-color-scheme` so system mode can be exercised. */
function stubMatchMedia(dark: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query = {
    matches: dark,
    addEventListener: (_: string, handler: (event: { matches: boolean }) => void) =>
      listeners.add(handler),
    removeEventListener: (_: string, handler: (event: { matches: boolean }) => void) =>
      listeners.delete(handler),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => query),
  );
  return {
    emit(nextDark: boolean) {
      query.matches = nextDark;
      listeners.forEach((handler) => handler({ matches: nextDark }));
    },
  };
}

describe("useUiStore", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-cg-theme");
    document.documentElement.style.colorScheme = "";
    setActivePinia(createPinia());
  });

  describe("theme", () => {
    it("follows the system by default", () => {
      stubMatchMedia(true);
      const ui = useUiStore();
      expect(ui.preference).toBe("system");
      expect(ui.mode).toBe("dark");
    });

    it("writes the attribute the tokens key off, immediately", () => {
      stubMatchMedia(true);
      useUiStore();
      // `immediate: true` — a consumer created later must not see an unset root.
      expect(document.documentElement.dataset.cgTheme).toBe("dark");
    });

    it("sets color-scheme so native controls follow", () => {
      stubMatchMedia(true);
      useUiStore();
      expect(document.documentElement.style.colorScheme).toBe("dark");
    });

    it("tracks a system change while in system mode", () => {
      const media = stubMatchMedia(false);
      const ui = useUiStore();
      expect(ui.mode).toBe("light");

      media.emit(true);
      expect(ui.mode).toBe("dark");
      expect(document.documentElement.dataset.cgTheme).toBe("dark");
    });

    it("lets a manual choice win, and survive a system change", () => {
      const media = stubMatchMedia(false);
      const ui = useUiStore();

      ui.setPreference("dark");
      expect(ui.mode).toBe("dark");

      // The user asked for dark explicitly; the OS switching to light must not
      // silently override that.
      media.emit(false);
      expect(ui.mode).toBe("dark");
    });

    it("persists the preference", () => {
      stubMatchMedia(false);
      useUiStore().setPreference("dark");
      expect(localStorage.getItem("calliope-studio.theme")).toBe("dark");
    });

    it("restores a persisted preference", () => {
      localStorage.setItem("calliope-studio.theme", "dark");
      stubMatchMedia(false);
      expect(useUiStore().mode).toBe("dark");
    });

    it("ignores a corrupt persisted preference", () => {
      localStorage.setItem("calliope-studio.theme", "chartreuse");
      stubMatchMedia(false);
      expect(useUiStore().preference).toBe("system");
    });

    it("cycles light, dark, system", () => {
      stubMatchMedia(false);
      const ui = useUiStore();
      ui.setPreference("light");

      ui.cycleTheme();
      expect(ui.preference).toBe("dark");
      ui.cycleTheme();
      expect(ui.preference).toBe("system");
      ui.cycleTheme();
      expect(ui.preference).toBe("light");
    });

    it("bumps the revision on every change, so canvas renderers repaint", () => {
      stubMatchMedia(false);
      const ui = useUiStore();
      const before = ui.revision;

      ui.setPreference("dark");
      expect(ui.revision).toBeGreaterThan(before);
    });

    it("does not bump the revision when the mode does not change", () => {
      stubMatchMedia(false);
      const ui = useUiStore();
      ui.setPreference("light");
      const settled = ui.revision;

      // "system" already resolved to light, so nothing to repaint.
      ui.setPreference("system");
      expect(ui.revision).toBe(settled);
    });

    it("writes the attribute before the revision is observable", () => {
      stubMatchMedia(false);
      const ui = useUiStore();
      let seen: string | undefined;

      // Stands in for charts/theme.ts, which reads getComputedStyle as soon as
      // the revision changes. If the attribute lagged, every consumer would
      // resolve the previous theme's colours and the change would appear to do
      // nothing at all.
      const stop = vi.fn(() => {
        seen = document.documentElement.dataset.cgTheme;
      });
      ui.$subscribe(stop, { flush: "sync" });
      ui.setPreference("dark");

      expect(seen).toBe("dark");
    });
  });

  describe("splitter geometry", () => {
    it("defaults to the three-panel layout", () => {
      stubMatchMedia(false);
      expect(useUiStore().splitterSizes).toEqual([20, 55, 25]);
    });

    it("round-trips through localStorage", () => {
      stubMatchMedia(false);
      useUiStore().setSplitterSizes([10, 70, 20]);

      setActivePinia(createPinia());
      expect(useUiStore().splitterSizes).toEqual([10, 70, 20]);
    });

    it("ignores a stored layout with the wrong number of panels", () => {
      // The shell's panel count changes during this migration; restoring three
      // sizes into two panels puts a panel at a width it never asked for.
      localStorage.setItem("calliope-studio.splitter.sizes", JSON.stringify([50, 50]));
      stubMatchMedia(false);
      expect(useUiStore().splitterSizes).toEqual([20, 55, 25]);
    });

    it("ignores corrupt stored geometry", () => {
      localStorage.setItem("calliope-studio.splitter.sizes", "not json");
      stubMatchMedia(false);
      expect(useUiStore().splitterSizes).toEqual([20, 55, 25]);
    });

    it("survives a localStorage that refuses to be written", () => {
      /**
       * Every *read* in this store was already guarded and none of the writes
       * were, which is the wrong way round: this one is called from the
       * splitter's `@layout`, so it fires on every frame of a drag, and Safari
       * in private mode throws from `setItem` for every origin. The drag took
       * the shell down with it.
       */
      stubMatchMedia(false);
      const ui = useUiStore();
      const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {
          throw new DOMException("QuotaExceededError");
        });

      try {
        expect(() => ui.setSplitterSizes([10, 70, 20])).not.toThrow();
        expect(() => ui.setPreference("dark")).not.toThrow();
        expect(() => ui.setResultsLayout("beside")).not.toThrow();
        expect(() => ui.setConfigAdvanced("init", true)).not.toThrow();
      } finally {
        setItem.mockRestore();
      }

      // The setting still applies this session; only its memory of tomorrow is
      // gone, which is the whole of what these keys are for.
      expect(ui.splitterSizes).toEqual([10, 70, 20]);
      expect(ui.preference).toBe("dark");
      expect(ui.resultsLayout).toBe("beside");
    });

    it("still constructs when localStorage refuses every write", () => {
      // The legacy-geometry migration removes two keys at store setup, outside
      // any `try`, so a blocked `removeItem` threw from `useUiStore()` itself —
      // there is no shell at all after that.
      const removeItem = vi
        .spyOn(Storage.prototype, "removeItem")
        .mockImplementation(() => {
          throw new DOMException("SecurityError");
        });
      stubMatchMedia(false);

      try {
        expect(() => useUiStore()).not.toThrow();
      } finally {
        removeItem.mockRestore();
      }
    });
  });

  describe("the results view's layouts", () => {
    it("opens stacked, with all three figures showing", () => {
      stubMatchMedia(false);
      const ui = useUiStore();
      expect(ui.resultsLayout).toBe("stacked");
      expect(ui.resultsGeometryNow.collapsed).toEqual({
        map: false,
        timeseries: false,
        static: false,
      });
    });

    it("remembers which layout is on screen", () => {
      stubMatchMedia(false);
      useUiStore().setResultsLayout("beside");

      setActivePinia(createPinia());
      expect(useUiStore().resultsLayout).toBe("beside");
    });

    it("ignores a layout it does not have", () => {
      localStorage.setItem("calliope-studio.results.layout", "kaleidoscope");
      stubMatchMedia(false);
      expect(useUiStore().resultsLayout).toBe("stacked");
    });

    it("keeps each layout's geometry to itself", () => {
      // The whole point. One geometry meant folding a figure away destroyed the
      // sizes of the arrangement it was folded out of, and unfolding it never
      // brought them back.
      stubMatchMedia(false);
      const ui = useUiStore();
      ui.setResultsSizes("main", [20, 80]);
      ui.setResultsCollapsed("static", true);

      ui.setResultsLayout("beside");
      expect(ui.resultsGeometryNow.sizes.main).toEqual([52, 48]);
      expect(ui.resultsGeometryNow.collapsed.static).toBe(false);
      ui.setResultsSizes("main", [70, 30]);

      ui.setResultsLayout("stacked");
      expect(ui.resultsGeometryNow.sizes.main).toEqual([20, 80]);
      expect(ui.resultsGeometryNow.collapsed.static).toBe(true);
    });

    it("survives a reload", () => {
      // Unlike `sectionView`: how the figures are arranged says what the user is
      // working on, and having it come back flat is what made this worth storing.
      stubMatchMedia(false);
      const ui = useUiStore();
      ui.setResultsSizes("charts", [80, 20]);
      ui.setResultsCollapsed("map", true);

      setActivePinia(createPinia());
      const reloaded = useUiStore();
      expect(reloaded.resultsGeometryNow.sizes.charts).toEqual([80, 20]);
      expect(reloaded.resultsGeometryNow.collapsed.map).toBe(true);
    });

    it("refuses a group layout that is not two panels", () => {
      stubMatchMedia(false);
      const ui = useUiStore();
      ui.setResultsSizes("main", [100]);
      expect(ui.resultsGeometryNow.sizes.main).toEqual([34, 66]);
    });

    it("drops a stored entry of the wrong shape, layout by layout", () => {
      localStorage.setItem(
        "calliope-studio.results.geometry",
        JSON.stringify({
          stacked: {
            sizes: { main: [10, 20, 70], charts: [50, 50] },
            collapsed: { map: false, timeseries: false, static: false },
          },
          beside: {
            sizes: { main: [30, 70], charts: [50, 50] },
            collapsed: { map: false, timeseries: false, static: true },
          },
        }),
      );
      stubMatchMedia(false);
      const ui = useUiStore();
      // A group handed three sizes for two panels leaves a panel without one,
      // so the whole entry falls back rather than being half-applied.
      expect(ui.resultsGeometryNow.sizes.main).toEqual([34, 66]);
      ui.setResultsLayout("beside");
      expect(ui.resultsGeometryNow.sizes.main).toEqual([30, 70]);
    });

    it("ignores corrupt stored geometry", () => {
      localStorage.setItem("calliope-studio.results.geometry", "not json");
      stubMatchMedia(false);
      expect(useUiStore().resultsGeometryNow.sizes.charts).toEqual([61, 39]);
    });

    it("resets the layout on screen and no other", () => {
      stubMatchMedia(false);
      const ui = useUiStore();
      ui.setResultsSizes("main", [20, 80]);
      ui.setResultsLayout("totals");
      ui.setResultsSizes("charts", [10, 90]);

      ui.resetResultsLayout();
      expect(ui.resultsGeometryNow.sizes.charts).toEqual([12, 88]);
      ui.setResultsLayout("stacked");
      expect(ui.resultsGeometryNow.sizes.main).toEqual([20, 80]);
    });

    it("knows when a layout is still as it ships", () => {
      stubMatchMedia(false);
      const ui = useUiStore();
      expect(ui.resultsLayoutIsDefault).toBe(true);

      ui.setResultsCollapsed("static", true);
      expect(ui.resultsLayoutIsDefault).toBe(false);

      ui.resetResultsLayout();
      expect(ui.resultsLayoutIsDefault).toBe(true);
    });

    it("folds the pre-layout keys into the stacked layout, once", () => {
      // `results.split` divided three sibling panels; the same arrangement is
      // now the map against a charts *column*, so the two chart shares are
      // renormalised inside it.
      localStorage.setItem(
        "calliope-studio.results.split",
        JSON.stringify({ 3: [50, 30, 20], 2: [70, 30] }),
      );
      localStorage.setItem(
        "calliope-studio.results.collapsed",
        JSON.stringify({ map: false, timeseries: false, static: true }),
      );
      stubMatchMedia(false);
      const ui = useUiStore();

      expect(ui.resultsGeometryNow.sizes.main).toEqual([50, 50]);
      expect(ui.resultsGeometryNow.sizes.charts).toEqual([60, 40]);
      expect(ui.resultsGeometryNow.collapsed.static).toBe(true);
      // Only the stacked layout: the others never existed before.
      ui.setResultsLayout("beside");
      expect(ui.resultsGeometryNow.sizes.main).toEqual([52, 48]);

      // And gone, so it can never overwrite what the user does next.
      expect(localStorage.getItem("calliope-studio.results.split")).toBeNull();
      expect(localStorage.getItem("calliope-studio.results.collapsed")).toBeNull();
    });

    it("leaves a corrupt legacy value to the defaults", () => {
      localStorage.setItem("calliope-studio.results.split", "not json");
      stubMatchMedia(false);
      expect(useUiStore().resultsGeometryNow.sizes.main).toEqual([34, 66]);
    });
  });

  describe("the geographic editors' view", () => {
    it("opens both nodes and links on the map", () => {
      // The whole point of the section: geography is edited on a map, and the
      // list is where you go when a map cannot say it.
      stubMatchMedia(false);
      const ui = useUiStore();
      expect(ui.sectionView.nodes).toBe("map");
      expect(ui.sectionView.links).toBe("map");
    });

    it("toggles one section without touching the other", () => {
      stubMatchMedia(false);
      const ui = useUiStore();

      ui.toggleSectionView("nodes");
      expect(ui.sectionView.nodes).toBe("structured");
      expect(ui.sectionView.links).toBe("map");

      ui.toggleSectionView("nodes");
      expect(ui.sectionView.nodes).toBe("map");
    });

    it("sets a view outright, for the greyed map's way out", () => {
      stubMatchMedia(false);
      const ui = useUiStore();
      ui.setSectionView("links", "structured");
      ui.setSectionView("links", "structured");
      expect(ui.sectionView.links).toBe("structured");
    });

    it("remembers no template for new links until one is picked", () => {
      stubMatchMedia(false);
      expect(useUiStore().newLinkTemplate).toBeNull();
    });
  });
});
