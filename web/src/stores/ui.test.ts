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
      expect(localStorage.getItem("calligraph.theme")).toBe("dark");
    });

    it("restores a persisted preference", () => {
      localStorage.setItem("calligraph.theme", "dark");
      stubMatchMedia(false);
      expect(useUiStore().mode).toBe("dark");
    });

    it("ignores a corrupt persisted preference", () => {
      localStorage.setItem("calligraph.theme", "chartreuse");
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
      localStorage.setItem("calligraph.splitter.sizes", JSON.stringify([50, 50]));
      stubMatchMedia(false);
      expect(useUiStore().splitterSizes).toEqual([20, 55, 25]);
    });

    it("ignores corrupt stored geometry", () => {
      localStorage.setItem("calligraph.splitter.sizes", "not json");
      stubMatchMedia(false);
      expect(useUiStore().splitterSizes).toEqual([20, 55, 25]);
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
