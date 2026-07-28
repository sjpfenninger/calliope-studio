/**
 * What is actually in a result frame's index column.
 *
 * Arrow hands the index back as a `Date`, a `bigint`, a string or a number
 * depending on the column type it was written as, and every consumer has to deal
 * with all four. There is one answer to "what is this value" and several
 * presentations of it: a chart's time axis wants epoch milliseconds, a CSV wants
 * text, a grid cell wants something renderable. Only the first of those belongs
 * here.
 *
 * Split out of `ResultChart.vue`'s `axisValues()` when the export buttons
 * arrived: a chart and the CSV of that same chart disagreeing about how a
 * timestep is written is exactly the kind of drift this project keeps out.
 */

/** An index value, once Arrow's representation has been normalised away. */
export type IndexValue = Date | string | number;

export function normaliseIndexValue(value: unknown): IndexValue {
  if (value instanceof Date) return value;
  // Arrow uses 64-bit integers for timestamps and for anything counted, and
  // `bigint` is contagious: it will not mix with a number in arithmetic and
  // `JSON.stringify` throws on it.
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return value == null ? "" : String(value);
}

/**
 * An index value as text, for a CSV or a grid cell.
 *
 * Timestamps are written in **UTC**, and deliberately: Calliope's timesteps are
 * naive local time and Arrow carries them as an instant, so reading them back
 * with the browser's local getters would shift every timestep by whatever the
 * viewer's offset happens to be — a model solved in Zürich would export an hour
 * earlier when opened in London.
 *
 * The seconds are kept and the milliseconds and zone marker dropped, which is
 * the form Calliope's own files use.
 */
export function indexToText(value: unknown): string {
  const normalised = normaliseIndexValue(value);
  if (!(normalised instanceof Date)) return String(normalised);

  const pad = (part: number, width = 2) => String(part).padStart(width, "0");
  const date = [
    pad(normalised.getUTCFullYear(), 4),
    pad(normalised.getUTCMonth() + 1),
    pad(normalised.getUTCDate()),
  ].join("-");
  const time = [
    pad(normalised.getUTCHours()),
    pad(normalised.getUTCMinutes()),
    pad(normalised.getUTCSeconds()),
  ].join(":");
  return `${date}T${time}`;
}

/**
 * An index value as it should be *read*.
 *
 * An index carries identity too: `choose_index` picks the largest dimension when
 * there are no timesteps, so a frame of `flow_cap` on a link-heavy model is
 * indexed by technology — and a link there must read `region1 → region2`, exactly
 * as it does in a legend, rather than reverting to its generated `a_to_b` name.
 * `techs` is the only dimension with display names, and the only one substituted,
 * so a node sharing a name with a technology is not renamed along with it.
 */
export function indexToLabel(
  value: unknown,
  indexName: string,
  labels: Record<string, string>,
): string {
  const text = indexToText(value);
  return indexName === "techs" ? (labels[text] ?? text) : text;
}
