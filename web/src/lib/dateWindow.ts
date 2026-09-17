/**
 * Days as the reader types them, and the zoom window they mean.
 *
 * The time-series chart is zoomed by a window in epoch milliseconds — what the
 * slider drags and what `dataZoom` takes — while the from/to boxes in its
 * toolbar hold days. These translate between the two, in UTC throughout, since
 * a timestep is drawn at its UTC instant (`frameIndex.ts`) and a day boundary
 * has to fall where the axis puts midnight.
 *
 * A day is inclusive on both ends: "to 29 May" means the whole of the 29th, so
 * the window it becomes ends at midnight *after* it. The reverse direction
 * subtracts a millisecond for the same reason, so a window the slider left at
 * 30 May 00:00 reads back as ending on the 29th rather than starting a day it
 * does not show.
 */
import { clipWindow, type Extent, type ZoomWindow } from "./chartZoom";

export const DAY = 24 * 3_600_000;

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Midnight UTC starting `day`, or null for anything that is not a day. */
export function dayStart(day: string): number | null {
  if (!DAY_SHAPE.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  // `Date.parse` accepts 2020-02-30 as 1 March; reading it back is what notices.
  return Number.isFinite(ms) && dayOf(ms) === day ? ms : null;
}

/** The UTC day an instant falls on. */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function plusDays(day: string, count: number): string | null {
  const start = dayStart(day);
  return start === null ? null : dayOf(start + count * DAY);
}

/** The last day of the week that starts on `from`. */
export function weekFrom(from: string): string | null {
  return plusDays(from, 6);
}

/**
 * The window covering `from` to `to` inclusive, clipped to the data.
 *
 * Null when either day is not one, when `to` precedes `from`, or when the
 * window would cover the whole extent anyway — which `clipWindow` reports as
 * null too, because a window over everything is the same as no window.
 */
export function windowFromDays(from: string, to: string, extent: Extent | null): ZoomWindow | null {
  const startValue = dayStart(from);
  const end = dayStart(to);
  if (startValue === null || end === null || end < startValue) return null;
  const window = { startValue, endValue: end + DAY };
  return extent ? clipWindow(window, extent) : window;
}

/** The days a window covers, for the boxes to show. */
export function daysFromWindow(window: ZoomWindow | null): { from: string; to: string } | null {
  if (!window) return null;
  return { from: dayOf(window.startValue), to: dayOf(window.endValue - 1) };
}

/** The days an extent spans, for the boxes' `min` and `max`. */
export function daysOfExtent(extent: Extent | null): { first: string; last: string } | null {
  if (!extent) return null;
  return { first: dayOf(extent[0]), last: dayOf(extent[1]) };
}

/** What typing into a day box comes to: a window to apply, or nothing yet. */
export type DayBoxOutcome =
  /** A whole day was entered and this is the window it means. */
  | { window: ZoomWindow | null }
  /** A `to` before the `from` on screen: marked, never silently swapped. */
  | { invalid: "to" }
  /** The box is mid-edit or was emptied; the window stays where it is. */
  | null;

/**
 * The window a `from` day asks for: the week starting there, held within
 * the data.
 *
 * "Show me this week" is the common question, and the `to` box is there to
 * change the answer. A date box reads as "" while one of its segments is
 * being typed and fires `change` on every segment, so an empty value is a box
 * mid-edit rather than a request to drop the window — typing the first digit
 * of a `to` used to empty `from` and the chart with it.
 */
export function windowForFrom(from: string, extent: Extent | null): DayBoxOutcome {
  if (!from) return null;
  const last = daysOfExtent(extent)?.last;
  let to = weekFrom(from) ?? from;
  if (last && to > last) to = last;
  return { window: windowFromDays(from, to, extent) };
}

/**
 * The window a `to` day asks for, given the `from` on screen — or, with no
 * `from`, the week ending there, the mirror of `windowForFrom`.
 *
 * A `to` before `from` is the one thing that cannot mean a window; which day
 * the reader meant to move is theirs to say, so it is reported rather than
 * swapped.
 */
export function windowForTo(
  to: string,
  currentFrom: string | null | undefined,
  extent: Extent | null,
): DayBoxOutcome {
  if (!to) return null;
  const first = daysOfExtent(extent)?.first;
  let from = currentFrom ?? plusDays(to, -6) ?? to;
  if (first && from < first) from = first;
  if (to < from) return { invalid: "to" };
  return { window: windowFromDays(from, to, extent) };
}
