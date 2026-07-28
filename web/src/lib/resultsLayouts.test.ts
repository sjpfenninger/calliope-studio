import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESULTS_LAYOUT,
  RESULTS_FIGURES,
  RESULTS_GROUPS,
  RESULTS_LAYOUTS,
  defaultGeometry,
  findLayout,
  isGeometry,
  isLayoutId,
  sameGeometry,
} from "./resultsLayouts";

/**
 * The layout table.
 *
 * Small assertions, but each one is a way the results view could come up wrong
 * without anything throwing: sizes that do not sum to 100 leave the splitter to
 * redistribute, a layout that turns on the map without declaring it needs one is
 * offered for a model with no geography, and a geometry that passes validation
 * with a missing group leaves a panel without a size.
 */
describe("results layouts", () => {
  it("has a default that exists and needs no map", () => {
    const fallback = findLayout(DEFAULT_RESULTS_LAYOUT);
    expect(fallback.id).toBe(DEFAULT_RESULTS_LAYOUT);
    // Everything falls back to it, including a model with no geography.
    expect(fallback.needsMap).toBe(false);
  });

  it("divides each group into exactly 100", () => {
    for (const layout of RESULTS_LAYOUTS) {
      for (const group of RESULTS_GROUPS) {
        const sizes = layout.geometry.sizes[group];
        expect(sizes).toHaveLength(2);
        expect(sizes[0] + sizes[1]).toBeCloseTo(100, 6);
      }
    }
  });

  it("says it needs a map exactly when it opens on one", () => {
    for (const layout of RESULTS_LAYOUTS) {
      // A layout that leaves the map open is about the map; one that folds it
      // away works perfectly well on a model that has no geography.
      const showsMap = !layout.geometry.collapsed.map;
      const isSideBySide = layout.direction === "horizontal";
      expect(layout.needsMap).toBe(
        isSideBySide || (showsMap && layout.id !== "stacked"),
      );
    }
  });

  it("leaves at least one chart open in every layout", () => {
    // Two panels both pinned to a title bar cannot fill their group — see
    // `useFigurePanels`. A shipped default must not be in that state.
    for (const layout of RESULTS_LAYOUTS) {
      const open = (["timeseries", "static"] as const).filter(
        (figure) => !layout.geometry.collapsed[figure],
      );
      expect(open.length).toBeGreaterThan(0);
    }
  });

  it("gives every layout a label, a tip and an icon", () => {
    for (const layout of RESULTS_LAYOUTS) {
      expect(layout.label.length).toBeGreaterThan(0);
      expect(layout.tip.length).toBeGreaterThan(0);
      expect(layout.icon).toBeTruthy();
    }
  });

  it("hands out a copy, not the table's own geometry", () => {
    const first = defaultGeometry("stacked");
    first.sizes.main[0] = 99;
    first.collapsed.map = true;
    expect(defaultGeometry("stacked").sizes.main[0]).not.toBe(99);
    expect(defaultGeometry("stacked").collapsed.map).toBe(false);
  });

  it("recognises its own ids and nothing else", () => {
    expect(isLayoutId("beside")).toBe(true);
    expect(isLayoutId("kaleidoscope")).toBe(false);
    expect(isLayoutId(undefined)).toBe(false);
    // An unknown id falls back rather than returning undefined, so a caller
    // cannot end up binding a panel group to nothing.
    expect(findLayout("nonsense" as never).id).toBe(RESULTS_LAYOUTS[0].id);
  });

  describe("validation", () => {
    const good = defaultGeometry("stacked");

    it("accepts what it writes", () => {
      expect(isGeometry(good)).toBe(true);
    });

    it("rejects a group of the wrong length", () => {
      expect(isGeometry({ ...good, sizes: { main: [1, 2, 3], charts: [50, 50] } })).toBe(
        false,
      );
    });

    it("rejects a missing group", () => {
      expect(isGeometry({ ...good, sizes: { main: [50, 50] } })).toBe(false);
    });

    it("rejects a size that is not a finite number", () => {
      expect(
        isGeometry({ ...good, sizes: { main: ["50", 50], charts: [50, 50] } }),
      ).toBe(false);
      expect(
        isGeometry({ ...good, sizes: { main: [NaN, 50], charts: [50, 50] } }),
      ).toBe(false);
    });

    it("rejects a collapsed flag that is not a boolean", () => {
      expect(
        isGeometry({ ...good, collapsed: { ...good.collapsed, map: "yes" } }),
      ).toBe(false);
    });

    it("rejects a figure with no flag at all", () => {
      expect(isGeometry({ ...good, collapsed: { map: false } })).toBe(false);
    });

    it("rejects what is not an object", () => {
      expect(isGeometry(null)).toBe(false);
      expect(isGeometry("stacked")).toBe(false);
    });
  });

  describe("comparing against the defaults", () => {
    it("matches a fresh copy", () => {
      expect(sameGeometry(defaultGeometry("map"), defaultGeometry("map"))).toBe(true);
    });

    it("ignores the fractions reka emits", () => {
      // The splitter re-emits its own defaults with a sub-pixel drift, and a
      // reset button that lights up for that is noise.
      const drifted = defaultGeometry("stacked");
      drifted.sizes.main = [34.2, 65.8];
      expect(sameGeometry(drifted, defaultGeometry("stacked"))).toBe(true);
    });

    it("notices a real drag", () => {
      const dragged = defaultGeometry("stacked");
      dragged.sizes.charts = [80, 20];
      expect(sameGeometry(dragged, defaultGeometry("stacked"))).toBe(false);
    });

    it("notices a folded figure", () => {
      const folded = defaultGeometry("stacked");
      folded.collapsed[RESULTS_FIGURES[0]] = true;
      expect(sameGeometry(folded, defaultGeometry("stacked"))).toBe(false);
    });
  });
});
