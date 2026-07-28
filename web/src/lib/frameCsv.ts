/**
 * A result frame as CSV — the one writer, for every figure and the table.
 *
 * The point of an export button is that the file *is* the figure: post-selector,
 * post-resample, post-sum, post-`drop_zeros`, and for a load-duration curve
 * post-sort. The browser is already holding precisely that — the `ResultFrame`
 * from `useResultFrame` is what the chart draws — so the export is written from
 * the frame rather than re-asked of the server, and there is no query that could
 * come back different by the time the button is pressed.
 *
 * One writer rather than one per surface, and pure so it can be tested, for the
 * reason `lib/entries.ts` is a module: this is what a user takes away and puts in
 * a paper.
 */
import type { ResultFrame } from "../api/results";
import { indexToLabel, indexToText } from "./frameIndex";
import { seriesLabel } from "./seriesLabel";
import { unitSuffix, type DisplayUnit } from "./units";

/** One frame to write, and what to call its columns when there are several. */
export interface CsvSource {
  /** Prefixed to every column name, when more than one source is given. */
  label?: string;
  frame: ResultFrame | null;
  /**
   * What this frame's values are measured in, already applied to them.
   *
   * Per source, not per file: the map exports three channels at once and they
   * are three different variables, so one of them may be in GWh beside another
   * in MW.
   */
  unit?: DisplayUnit | null;
}

const DELIMITER = ",";
const NEWLINE = "\n";

/** Prefix separator for a multi-source export. Not the delimiter, obviously. */
const LABEL_SEPARATOR = " · ";

/**
 * One CSV field, quoted only where it has to be.
 *
 * Series labels already contain `|` and `→` today, and a model's own identifiers
 * are not ours to constrain — a node called `north, west` is legal Calliope and
 * would otherwise split a header row.
 */
function escape(field: string): string {
  if (!/[",\r\n]/.test(field)) return field;
  return `"${field.replace(/"/g, '""')}"`;
}

/**
 * A number as text.
 *
 * `String`, never `toLocaleString`: under a European locale the latter renders
 * `1234.5` as `1.234,5`, and that comma would take the column count apart. The
 * grid may format for reading — see `tableRows.ts` — but the file may not, and it
 * is written at full precision because trimming it would be a silent, unasked-for
 * loss in the artefact someone is about to do arithmetic on.
 */
function valueToText(value: number | undefined): string {
  // A gap in a series, or the padding a duration curve puts under its shorter
  // columns. An empty field is what every reader takes as missing; the literal
  // text `NaN` is what several take as a string, poisoning the column's type.
  if (value === undefined || Number.isNaN(value)) return "";
  return String(value);
}

/**
 * CSV text for one or more frames.
 *
 * Several sources are joined on their shared index, which is what lets the map
 * export the channels it is drawing as a single file. Rows appear in the order
 * the first source has them, with any index value only later sources have
 * appended — a source narrowed differently should not silently drop rows.
 *
 * Args:
 *   sources: The frames to write. Null or empty frames contribute no columns.
 *   labels: Display text per technology, so a column reads exactly as its
 *     legend entry does.
 */
export function frameToCsv(
  sources: CsvSource[],
  labels: Record<string, string> = {},
): string {
  const present = sources.filter(
    (source): source is CsvSource & { frame: ResultFrame } =>
      source.frame !== null && source.frame.series.length > 0,
  );
  if (!present.length) return "";

  const prefixed = present.length > 1;
  const indexName = present[0].frame.indexName || "index";

  // The row spine: every index value any source has, in first-seen order.
  const rowOf = new Map<string, number>();
  const spine: string[] = [];
  for (const { frame } of present) {
    for (const value of frame.index) {
      const key = indexToText(value, frame.indexIsTime);
      if (rowOf.has(key)) continue;
      rowOf.set(key, spine.length);
      spine.push(key);
    }
  }

  const header = [indexName];
  // One column per series, already positioned on the spine.
  const columns: string[][] = [];

  for (const { frame, label, unit } of present) {
    // Where each of this frame's rows lands in the spine, computed once rather
    // than per series: a frame has a handful of series and up to a year of hours.
    const positions = frame.index.map(
      (value) => rowOf.get(indexToText(value, frame.indexIsTime))!,
    );

    for (const series of frame.series) {
      const name = seriesLabel(series, frame.seriesDims, labels);
      // The values below are the figure's, scaled; naming the unit in the header
      // is what keeps the file honest about that. It goes here rather than into
      // `valueToText`, which stays full-precision and locale-free — a number a
      // spreadsheet can do arithmetic on, with the unit alongside it, not in it.
      header.push(
        (prefixed && label ? `${label}${LABEL_SEPARATOR}${name}` : name) +
          unitSuffix(unit),
      );

      const column = new Array<string>(spine.length).fill("");
      positions.forEach((row, position) => {
        column[row] = valueToText(series.values[position]);
      });
      columns.push(column);
    }
  }

  const lines = [header.map(escape).join(DELIMITER)];
  for (let row = 0; row < spine.length; row += 1) {
    // Labelled on the way out, not on the way in: the spine is joined on the raw
    // text, so two things sharing a display name could never merge into one row.
    const index = escape(indexToLabel(spine[row], indexName, labels));
    lines.push([index, ...columns.map((column) => column[row])].join(DELIMITER));
  }
  return lines.join(NEWLINE) + NEWLINE;
}

/**
 * A filename for an export, safe on every platform.
 *
 * A Calliope model may be called anything at all, and a name carrying a slash
 * would otherwise be read as a path by the browser's download handler.
 */
export function csvFilename(model: string | null | undefined, variable: string): string {
  const clean = (part: string) =>
    part.replace(/[/\\:*?"<>|]+/g, "-").replace(/\s+/g, "_") || "results";
  return `${clean(model || "results")}-${clean(variable)}.csv`;
}
