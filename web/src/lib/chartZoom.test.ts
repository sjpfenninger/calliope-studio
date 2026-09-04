import { describe, expect, it } from "vitest";

import { clipWindow, isZoomed, windowFromEvent, windowFromPercent, type Extent } from "./chartZoom";

/** A ten-day hourly axis, in epoch milliseconds, the way `axisValues` draws one. */
const DAY = 24 * 3600 * 1000;
const EXTENT: Extent = [0, 10 * DAY];

describe("windowFromEvent", () => {
  /**
   * A slider drag is the common case, and it arrives as percentages of the
   * axis. Converted through the extent that was on screen, the window is the
   * same two instants whatever frame is drawn next — which is the whole point:
   * a daily resample or another variable has a different extent, and a
   * percentage of it is a different week.
   */
  it("turns a slider drag into values on the drawn extent", () => {
    expect(windowFromEvent({ type: "datazoom", start: 20, end: 30 }, EXTENT)).toEqual({
      startValue: 2 * DAY,
      endValue: 3 * DAY,
    });
  });

  /** A wheel or pan reports through `batch`, and the first entry is the axis. */
  it("reads a wheel zoom out of its batch", () => {
    const params = { type: "datazoom", batch: [{ dataZoomId: "x", start: 50, end: 60 }] };
    expect(windowFromEvent(params, EXTENT)).toEqual({ startValue: 5 * DAY, endValue: 6 * DAY });
  });

  /**
   * A script zooms with values — that is how the showcase screenshot picks its
   * week — and those need no extent to mean something.
   */
  it("takes values as they are", () => {
    const params = { type: "datazoom", startValue: DAY, endValue: 2 * DAY };
    expect(windowFromEvent(params, null)).toEqual({ startValue: DAY, endValue: 2 * DAY });
  });

  it("clamps values to the extent, and treats the whole of it as no zoom", () => {
    expect(windowFromEvent({ startValue: -DAY, endValue: 2 * DAY }, EXTENT)).toEqual({
      startValue: 0,
      endValue: 2 * DAY,
    });
    expect(windowFromEvent({ startValue: -DAY, endValue: 20 * DAY }, EXTENT)).toBeNull();
  });

  /**
   * "No zoom" has one spelling, so a replace that carries `null` is a replace
   * that carries nothing — and dragging the slider home is what produces it.
   */
  it("reports the full range as null", () => {
    expect(windowFromEvent({ start: 0, end: 100 }, EXTENT)).toBeNull();
    expect(windowFromEvent({ start: 0, end: 100 - 1e-9 }, EXTENT)).toBeNull();
  });

  /**
   * Percentages of nothing are nothing: before a frame has drawn, or on a
   * category axis, there is no extent, and inventing one would carry a window
   * onto a chart it was never set on.
   */
  it("has no answer without an extent", () => {
    expect(windowFromEvent({ start: 20, end: 30 }, null)).toBeNull();
    expect(windowFromEvent({ start: 20, end: 30 }, [DAY, DAY])).toBeNull();
  });

  it("ignores what is not an event", () => {
    expect(windowFromEvent(null, EXTENT)).toBeNull();
    expect(windowFromEvent("datazoom", EXTENT)).toBeNull();
    expect(windowFromEvent({ batch: [] }, EXTENT)).toBeNull();
  });

  /** `dispatchAction` may set one end alone; the other stays where the axis is. */
  it("fills a missing end from the axis", () => {
    expect(windowFromEvent({ end: 30 }, EXTENT)).toEqual({ startValue: 0, endValue: 3 * DAY });
    expect(windowFromEvent({ start: 70 }, EXTENT)).toEqual({
      startValue: 7 * DAY,
      endValue: 10 * DAY,
    });
  });
});

describe("windowFromPercent", () => {
  it("clamps to 0–100 and rejects an inverted window", () => {
    expect(windowFromPercent(-10, 50, EXTENT)).toEqual({ startValue: 0, endValue: 5 * DAY });
    expect(windowFromPercent(60, 50, EXTENT)).toBeNull();
  });
});

describe("isZoomed", () => {
  /**
   * The reset button wants an answer on a category axis too, where the
   * percentages convert to no window: a duration curve zoomed into its top
   * hundred hours is zoomed.
   */
  it("answers from percentages alone", () => {
    expect(isZoomed({ start: 0, end: 99 }, null)).toBe(true);
    expect(isZoomed({ batch: [{ start: 1, end: 100 }] }, null)).toBe(true);
    expect(isZoomed({ start: 0, end: 100 }, null)).toBe(false);
  });

  it("measures values against the extent when there is one", () => {
    expect(isZoomed({ startValue: 0, endValue: 10 * DAY }, EXTENT)).toBe(false);
    expect(isZoomed({ startValue: DAY, endValue: 10 * DAY }, EXTENT)).toBe(true);
    expect(isZoomed({ startValue: DAY, endValue: 2 * DAY }, null)).toBe(true);
  });

  it("is false for what is not an event", () => {
    expect(isZoomed(undefined, EXTENT)).toBe(false);
  });
});

describe("clipWindow", () => {
  // A window carried across a replace has to land on the new axis: handed
  // over unclipped, one that missed it left ECharts clamped to an edge with
  // the reset button still showing.
  it("keeps a window inside the extent", () => {
    expect(clipWindow({ startValue: 20, endValue: 30 }, [0, 100])).toEqual({
      startValue: 20,
      endValue: 30,
    });
  });

  it("clips a window overlapping an edge", () => {
    expect(clipWindow({ startValue: -10, endValue: 30 }, [0, 100])).toEqual({
      startValue: 0,
      endValue: 30,
    });
  });

  it("drops a window that misses the extent", () => {
    expect(clipWindow({ startValue: 200, endValue: 300 }, [0, 100])).toBeNull();
  });

  it("drops a window that covers the extent, which is no zoom", () => {
    expect(clipWindow({ startValue: -5, endValue: 500 }, [0, 100])).toBeNull();
  });

  it("has nothing to say without a window or an extent", () => {
    expect(clipWindow(null, [0, 100])).toBeNull();
    expect(clipWindow({ startValue: 1, endValue: 2 }, null)).toBeNull();
  });
});
