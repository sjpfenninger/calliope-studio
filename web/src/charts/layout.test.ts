import { describe, expect, it } from "vitest";

import {
  GRID_BOTTOM,
  LEGEND_H,
  ZOOM_BOTTOM,
  ZOOM_GAP,
  ZOOM_H,
  gridBottom,
  zoomBottom,
} from "./layout";

/**
 * The point of this module is that the numbers are derived rather than merely
 * agreeing, so what is worth testing is the derivation surviving the legend being
 * taken away — a chart coloured by its axis has no legend and should get that
 * strip back as plot area.
 */
describe("chart layout", () => {
  it("keeps the slider clear of the legend when there is one", () => {
    expect(zoomBottom(true)).toBe(ZOOM_BOTTOM);
    expect(zoomBottom(true)).toBeGreaterThanOrEqual(LEGEND_H);
    expect(gridBottom(true)).toBe(GRID_BOTTOM);
  });

  it("reclaims the legend's strip when there is none", () => {
    expect(gridBottom(false)).toBe(GRID_BOTTOM - LEGEND_H);
    // The slider still needs its own room and its gap, whatever is below it.
    expect(gridBottom(false) - zoomBottom(false)).toBe(ZOOM_H + ZOOM_GAP);
  });
});
