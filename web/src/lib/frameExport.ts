/**
 * Writing out exactly what a figure is drawing.
 *
 * From the frame the chart is holding, not a fresh request: the frame *is* the
 * figure, already selector-narrowed, resampled, summed and stripped of its empty
 * series by the server. A second request could come back different — the
 * selection may have moved since the button was drawn — and then the file would
 * not be the picture it was taken from.
 *
 * The time series follows `plotType` with it: in `Duration` the frame is indexed
 * by `period` with every series sorted on its own, so the file is the
 * load-duration curve. That is not a quirk to work around; it is the figure.
 *
 * A module rather than a method on the results pane, because each figure owns
 * its own export button now and three copies of this is three chances for one of
 * them to fetch afresh.
 */
import { saveText } from "./download";
import { csvFilename, frameToCsv, type CsvSource } from "./frameCsv";
import type { ResultFrame } from "@/api/results";

/**
 * Args:
 *   sources: The frames the figure is drawing.
 *   variable: What to name the file after.
 *   model: The model's name, for the same.
 *   labels: Display text per technology.
 *   precision: Always `stores/rounding.ts::exportPrecision`, never the display
 *     precision — which is null unless the user has ticked "apply to downloads".
 *     Passing the display one here is the mistake this parameter is named to
 *     prevent.
 */
export function exportFrames(
  sources: CsvSource[],
  variable: string,
  model: string | null | undefined,
  labels: Record<string, string>,
  precision: number | null = null,
): void {
  // Built before anything is awaited: `saveText` opens a file picker, and that
  // needs the click's user gesture still to be live.
  const csv = frameToCsv(sources, labels, precision);
  if (!csv) return;
  void saveText(csvFilename(model, variable), csv);
}

export function hasData(frame: ResultFrame | null): boolean {
  return Boolean(frame && frame.series.length > 0);
}
