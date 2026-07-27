/**
 * What to call a series in a chart.
 *
 * The server names a series by joining its dimension values — `region1 |
 * region1_to_region2` for a frame split by node and technology — so relabelling a
 * link cannot be a lookup on that name. It is rebuilt from the coordinates instead,
 * substituting only the `techs` component: a node that happens to share a name with
 * a technology must not be renamed along with it.
 *
 * `techs` is also the component the server attaches colour to, so the one part of a
 * series that has an identity of its own is the one part relabelled here.
 */
import type { Series } from "../api/results";

/** How the server joins dimension values. Mirrors `frames.SERIES_SEPARATOR`. */
export const SERIES_SEPARATOR = " | ";

/**
 * A series' display name.
 *
 * Args:
 *   series: The series, carrying its coordinates in `dims`.
 *   seriesDims: The dimensions it is split by, in the order the key uses.
 *   labels: Display text per technology, for those that have one.
 */
export function seriesLabel(
  series: Series,
  seriesDims: string[],
  labels: Record<string, string>,
): string {
  // Summed over technologies, or fully reduced: nothing to substitute, and the
  // server's own name is already right.
  if (!seriesDims.length || !seriesDims.includes("techs")) return series.key;

  const parts = seriesDims.map((dimension) => {
    const value = series.dims[dimension];
    if (value === undefined) return "";
    return dimension === "techs" ? (labels[value] ?? value) : value;
  });
  return parts.filter(Boolean).join(SERIES_SEPARATOR) || series.key;
}
