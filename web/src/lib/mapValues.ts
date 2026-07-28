/**
 * Turning a nodes-indexed result frame into what the map draws.
 *
 * The map asks for a variable with `index: "nodes"`, so every row of the frame is
 * one node. What it needs back is either a single number per node — for the size
 * and colour channels — or a breakdown by technology, for the pies.
 *
 * A module rather than a computed inside `RunResultsPanel` because there are
 * three channels now, all wanting the same reduction, and because this is the
 * step where a wrong answer looks entirely plausible: a marker sized by the sum
 * of the wrong series is still a marker. Pure, so it can be tested against a
 * frame built by hand.
 */
import type { ResultFrame } from "../api/results";

/** One wedge of a node's pie: a technology and its share. */
export interface PieSlice {
  key: string;
  value: number;
  color?: string;
}

/**
 * The dimension a pie's slices are grouped by.
 *
 * `sum_by` takes a single dimension server-side, so a pie query can collapse
 * neither `carriers` nor `costs` on the way out and the frame arrives with one
 * series per remaining combination. Grouping here is what turns that back into
 * one slice per technology — and the technology is the only dimension whose
 * colour the server stamps into the Arrow field metadata, which is what makes a
 * wedge the same colour as its bar in the charts below.
 */
const SLICE_DIM = "techs";

/**
 * Per-node totals, keyed by node.
 *
 * Sums across whatever series survived the query: `sum_by` has already collapsed
 * technologies, but `carriers` or `costs` may still be separate columns, and the
 * map is showing one number per node. NaN — a series that does not apply at that
 * node — contributes nothing rather than poisoning the sum.
 *
 * A node totalling exactly zero is left out entirely, so it draws at the uniform
 * size rather than as an invisible dot.
 */
export function nodeTotals(frame: ResultFrame | null): Record<string, number> {
  if (!frame) return {};
  const totals: Record<string, number> = {};
  frame.index.forEach((node, position) => {
    const sum = frame.series.reduce((running, series) => {
      const value = series.values[position];
      return Number.isNaN(value) ? running : running + value;
    }, 0);
    if (sum !== 0) totals[String(node)] = sum;
  });
  return totals;
}

/**
 * Per-node slices, keyed by node, largest first.
 *
 * Negative contributions are dropped rather than made absolute: a pie shows
 * composition of a whole, and a wedge for something that subtracts from the
 * total cannot be drawn honestly. Ordering is by magnitude so the wedges are
 * stable between nodes and the legend reads top-down.
 */
export function nodeSlices(frame: ResultFrame | null): Record<string, PieSlice[]> {
  if (!frame) return {};
  const byNode: Record<string, PieSlice[]> = {};

  frame.index.forEach((node, position) => {
    const totals = new Map<string, PieSlice>();
    for (const series of frame.series) {
      const value = series.values[position];
      if (!Number.isFinite(value) || value <= 0) continue;
      const key = series.dims[SLICE_DIM] ?? series.key;
      const existing = totals.get(key);
      if (existing) existing.value += value;
      else totals.set(key, { key, value, color: series.color });
    }
    const slices = [...totals.values()].sort((a, b) => b.value - a.value);
    if (slices.length) byNode[String(node)] = slices;
  });

  return byNode;
}

/** The largest magnitude in a set of node values, or 0 when there are none. */
export function largestMagnitude(values: Record<string, number>): number {
  const magnitudes = Object.values(values).map(Math.abs);
  return magnitudes.length ? Math.max(...magnitudes) : 0;
}

/** The smallest and largest value present, for a legend. Null when empty. */
export function valueExtent(
  values: Record<string, number>,
): [min: number, max: number] | null {
  const numbers = Object.values(values).filter(Number.isFinite);
  if (!numbers.length) return null;
  return [Math.min(...numbers), Math.max(...numbers)];
}
