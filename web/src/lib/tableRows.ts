/**
 * A result frame as AG Grid columns and rows.
 *
 * The reading half of what `frameCsv.ts` writes: same frame, same column names,
 * same index labels — so the table on screen and the file it exports cannot
 * describe the same query differently. The one thing that does differ is number
 * formatting, and deliberately: a cell is read at a glance and a CSV is read by
 * a spreadsheet, so this trims float noise and the file does not.
 */
import type { ColDef } from "ag-grid-community";

import type { ResultFrame } from "../api/results";
import { indexToLabel, indexToText } from "./frameIndex";
import { formatValue } from "./precision";
import { seriesLabel } from "./seriesLabel";
import { unitSuffix, type DisplayUnit } from "./units";

export interface GridShape {
  columns: ColDef[];
  rows: Record<string, unknown>[];
}

/**
 * The AG Grid field name for column `i`.
 *
 * Positional, never the series key — the same rule, for the same reason, as
 * `composables/useCsvGrid.ts`: AG Grid reads `field` as a path expression, and a
 * series key is `region1 | region1_to_region2`, full of spaces and separators.
 * The label lives in `headerName`, where it is text and nothing else.
 */
function fieldFor(i: number): string {
  return `c${i}`;
}

/**
 * Args:
 *   frame: The scaled frame the grid is showing.
 *   labels: Display text per technology, so a column reads as its legend entry.
 *   unit: What the values are measured in, already applied to them.
 *   precision: Significant figures to show, or null for full precision. See
 *     `lib/precision.ts` — a cell, a tooltip and a map popup all read numbers by
 *     that one rule now, so the same value cannot read three ways.
 */
export function frameToGrid(
  frame: ResultFrame | null,
  labels: Record<string, string> = {},
  unit: DisplayUnit | null = null,
  precision: number | null = null,
): GridShape {
  if (!frame || !frame.series.length) return { columns: [], rows: [] };

  const indexName = frame.indexName || "index";

  const columns: ColDef[] = [
    {
      field: fieldFor(0),
      headerName: indexName,
      // The index is what a reader scans down to find a row, so it stays put.
      pinned: "left",
      minWidth: 150,
    },
    // The unit goes on every column rather than once above them: it is what the
    // CSV can say, and a grid that named it somewhere the file could not would
    // be the two describing one query differently. The cells hold the scaled
    // number, so a header that omitted it would be wrong rather than terse.
    ...frame.series.map((series, position) => ({
      field: fieldFor(position + 1),
      headerName: seriesLabel(series, frame.seriesDims, labels) + unitSuffix(unit),
      type: "numericColumn",
      valueFormatter: (params: { value: unknown }) =>
        formatValue(params.value as number | undefined, precision),
    })),
  ];

  const rows = frame.index.map((value, row) => {
    const entry: Record<string, unknown> = {
      [fieldFor(0)]: indexToLabel(
        indexToText(value, frame.indexIsTime),
        indexName,
        labels,
      ),
    };
    frame.series.forEach((series, position) => {
      const cell = series.values[row];
      // Undefined rather than NaN: AG Grid sorts and filters on the raw value,
      // and NaN compares false against everything including itself.
      entry[fieldFor(position + 1)] = Number.isNaN(cell) ? undefined : cell;
    });
    return entry;
  });

  return { columns, rows };
}
