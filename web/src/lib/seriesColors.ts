/**
 * Technology colours for a chart whose *index* is the technologies.
 *
 * Summing a dimension away promotes the one left standing onto the axis: sum the
 * nodes out of `flow_cap` and each bar is a technology, with the carriers as the
 * series. Colour is stamped per series, so there was none to be had and every bar
 * came out the same flat blue — the one thing a chart of eight technologies must
 * not be, and inconsistent with the map and every other chart, where a technology
 * has one colour throughout.
 *
 * The catalogue's `colors` is the same per-model assignment the server stamps
 * into the Arrow field metadata (`results/colors.py`), so this is the one answer
 * arriving by a second route, not a second answer.
 */
import type { ResultFrame } from "@/api/results";
import type { SumBy } from "@/stores/runSelection";

export function indexColorsFor(
  frame: ResultFrame | null,
  sum: SumBy,
  colors: Record<string, string> | null,
): Record<string, string> | null {
  if (frame?.indexName !== "techs") return null;
  // The aggregation is what says the axis is the point. Summing the nodes away
  // asks for totals *by technology*, so the technologies are the comparison and
  // the carriers left over are detail. With nothing summed the series are still
  // the comparison being made — one bar per technology split by node and carrier
  // — and their legend is doing real work, so colour stays on them.
  if (sum === "none") return null;
  return colors;
}
