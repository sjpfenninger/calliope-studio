/**
 * What a chart's dataZoom is showing, in axis values, so it can outlive the
 * option that carried it.
 *
 * ECharts keeps the reader's zoom window inside the instance and nowhere else,
 * and a `notMerge` render — which is what a change of variable, aggregation or
 * plot kind has to be, because a merge never removes a series — starts from a
 * fresh option and forgets it. So `ResultChart` listens for the window and hands
 * it back to the next replace. The event reports it as percentages of the axis
 * extent (a slider drag as `start`/`end` on the payload, a wheel or pan inside a
 * `batch`), and a percentage means nothing once the extent changes under it: a
 * daily resample ends a few hours earlier than the hourly frame did, and a new
 * variable need not span the same timesteps at all. Values are what survive,
 * so the conversion happens here, against the extent of the frame that was on
 * screen when the reader zoomed.
 *
 * Pure, because a mistake here is a chart quietly showing the wrong week.
 */

export interface ZoomWindow {
  startValue: number;
  endValue: number;
}

/** The first and last value on the axis, in the axis's own units. */
export type Extent = [number, number];

interface RangeLike {
  start?: unknown;
  end?: unknown;
  startValue?: unknown;
  endValue?: unknown;
}

/**
 * Within this many percent of an edge counts as touching it: ECharts reports a
 * slider dragged home as `0` and `100` exactly, but a wheel-out lands where the
 * arithmetic puts it.
 */
const EDGE = 1e-6;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The one range a `datazoom` event describes, whichever shape it arrived in. */
function rangeOf(params: unknown): RangeLike | null {
  if (!params || typeof params !== "object") return null;
  const batch = (params as { batch?: unknown }).batch;
  if (Array.isArray(batch)) {
    const first: unknown = batch[0];
    return first && typeof first === "object" ? (first as RangeLike) : null;
  }
  return params as RangeLike;
}

/**
 * `window` clipped to `extent`, or null when it misses the axis or covers it.
 *
 * A window carried across a replace used to be handed over unclipped; one
 * that missed the new axis — a monthly frame after a zoom into one day of an
 * hourly one — left ECharts clamped to an edge with the reset button showing.
 */
export function clipWindow(window: ZoomWindow | null, extent: Extent | null): ZoomWindow | null {
  if (!window || !extent) return null;
  const startValue = Math.max(window.startValue, extent[0]);
  const endValue = Math.min(window.endValue, extent[1]);
  if (endValue <= startValue) return null;
  if (startValue === extent[0] && endValue === extent[1]) return null;
  return { startValue, endValue };
}

/** Whether `[start, end]` in percent is anything narrower than everything. */
const narrowerThanAll = (start: number, end: number): boolean =>
  start > EDGE || end < 100 - EDGE;

/**
 * A percent window on `extent`, or null when it is the whole extent or cannot
 * be placed on one.
 */
export function windowFromPercent(
  start: number,
  end: number,
  extent: Extent | null,
): ZoomWindow | null {
  if (!extent) return null;
  const [min, max] = extent;
  if (!(max > min)) return null;
  const low = Math.min(100, Math.max(0, start));
  const high = Math.min(100, Math.max(0, end));
  if (high <= low || !narrowerThanAll(low, high)) return null;
  const span = max - min;
  return { startValue: min + (span * low) / 100, endValue: min + (span * high) / 100 };
}

/**
 * The window a `datazoom` event leaves the chart showing, in axis values.
 *
 * Values on the event win — that is how a script zooms, and they need no
 * extent to mean something. Percentages need the extent of what was drawn;
 * without one there is no honest answer, and null is the honest answer. A
 * window that covers the whole extent is null too, so "no zoom" has one
 * spelling.
 */
export function windowFromEvent(params: unknown, extent: Extent | null): ZoomWindow | null {
  const range = rangeOf(params);
  if (!range) return null;
  const startValue = asNumber(range.startValue);
  const endValue = asNumber(range.endValue);
  if (startValue !== null && endValue !== null) {
    if (endValue <= startValue) return null;
    if (extent && extent[1] > extent[0]) {
      const clamped: ZoomWindow = {
        startValue: Math.max(startValue, extent[0]),
        endValue: Math.min(endValue, extent[1]),
      };
      if (clamped.startValue <= extent[0] && clamped.endValue >= extent[1]) return null;
      return clamped.endValue > clamped.startValue ? clamped : null;
    }
    return { startValue, endValue };
  }
  return windowFromPercent(asNumber(range.start) ?? 0, asNumber(range.end) ?? 100, extent);
}

/**
 * Whether a `datazoom` event leaves anything zoomed at all, on any axis.
 *
 * Separate from `windowFromEvent` because it needs no extent: a duration curve
 * sits on a category axis whose percentages convert to nothing, and it still
 * wants its reset button.
 */
export function isZoomed(params: unknown, extent: Extent | null): boolean {
  const range = rangeOf(params);
  if (!range) return false;
  const startValue = asNumber(range.startValue);
  const endValue = asNumber(range.endValue);
  if (startValue !== null && endValue !== null) {
    if (!extent) return true;
    return startValue > extent[0] || endValue < extent[1];
  }
  return narrowerThanAll(asNumber(range.start) ?? 0, asNumber(range.end) ?? 100);
}
