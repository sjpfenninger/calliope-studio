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
import { indexToLabel } from "./frameIndex";
import { seriesLabel } from "./seriesLabel";

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
 * A number as a cell.
 *
 * `toPrecision` then back through `Number` is what removes the trailing
 * `0000000004` a float sum leaves behind, without rounding anything a solver
 * would call significant. Very large and very small magnitudes go exponential,
 * because a column of digits nobody can count is not information.
 */
export function formatCell(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e9 || magnitude < 1e-4) return value.toExponential(4);
  return String(Number(value.toPrecision(10)));
}

export function frameToGrid(
  frame: ResultFrame | null,
  labels: Record<string, string> = {},
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
    ...frame.series.map((series, position) => ({
      field: fieldFor(position + 1),
      headerName: seriesLabel(series, frame.seriesDims, labels),
      type: "numericColumn",
      valueFormatter: (params: { value: unknown }) =>
        formatCell(params.value as number | undefined),
    })),
  ];

  const rows = frame.index.map((value, row) => {
    const entry: Record<string, unknown> = {
      [fieldFor(0)]: indexToLabel(value, indexName, labels),
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
