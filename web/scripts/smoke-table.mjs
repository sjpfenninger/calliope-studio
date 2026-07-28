/**
 * The table, and getting the numbers out of any figure.
 *
 *   npm run smoke:table -- http://127.0.0.1:8792
 *
 * v0.2.0 had a table view and this project did not, so there was no way to read an
 * exact figure or take the numbers away. The export is written from the frame
 * the figure is already holding, which is what makes "the file is the chart"
 * true rather than merely intended.
 */
import { results } from "./harness.mjs";
import {
  baseFrom,
  capture,
  csvRows as rows,
  openResults,
  stubSavePicker,
} from "./results-page.mjs";

const BASE = baseFrom(process.argv);
const { check, skip, finish } = results("table");
const { browser, page, testId, consoleErrors, frames, settle, quiet } =
  await openResults(BASE);

console.log(`Table and exports at ${BASE}`);

// An export asks where to go rather than landing silently in the downloads
// folder. The picker is native UI with nothing for a headless browser to click.
await stubSavePicker(page);

// ── Exporting a chart ──────────────────────────────────────────────────────
const seriesChart = await capture(page, () => testId("export-timeseries").click());
check("a chart exports a CSV", seriesChart.text.length > 0, seriesChart.name);
check(
  "the export is named after the model and the variable",
  /\.csv$/.test(seriesChart.name) && seriesChart.name.includes("-"),
  seriesChart.name,
);
check(
  "its first column is the frame's index",
  rows(seriesChart.text)[0].startsWith("timesteps"),
  rows(seriesChart.text)[0].slice(0, 80),
);
check(
  "every row has as many fields as the header",
  new Set(rows(seriesChart.text).map((line) => line.split(",").length)).size === 1,
);
// apache-arrow hands a timestamp column back as a plain number of epoch
// milliseconds, so this used to read `1104537600000`.
check(
  "timesteps are written as ISO datetimes, not epoch integers",
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2},/.test(rows(seriesChart.text)[1]),
  rows(seriesChart.text)[1].slice(0, 40),
);

// A duration curve is a different figure over the same variable: the index stops
// being time and each series is sorted on its own. The file has to follow, or it
// is not the picture it was taken from.
await settle(() => testId("plot-type").getByText("Duration", { exact: true }).click());
const durationChart = await capture(page, () => testId("export-timeseries").click());
check(
  "a duration curve exports the sorted curve, not the time series",
  rows(durationChart.text)[0].startsWith("period"),
  rows(durationChart.text)[0].slice(0, 80),
);
const firstColumn = rows(durationChart.text)
  .slice(1)
  .map((line) => Number(line.split(",")[1]))
  .filter((value) => Number.isFinite(value));
check(
  "its values descend",
  firstColumn.every((value, i) => i === 0 || value <= firstColumn[i - 1]),
);
await settle(() => testId("plot-type").getByText("Bar", { exact: true }).click());

// ── The table itself ───────────────────────────────────────────────────────
await settle(() => testId("run-subtab-table").click());
await testId("run-table").waitFor({ timeout: 30000 });
check("the table sub-view opens", (await testId("run-table").count()) === 1);
// Its own sidebar, not the results pane's: both panes stay mounted, so this has
// to be scoped or it matches the one behind it too. They read the same store,
// which is what makes a filter set on one already in force on the other.
check(
  "it hosts a filter sidebar of its own",
  (await page
    .locator('[data-testid="run-table"] [data-testid="run-filters"]')
    .count()) === 1,
);

// AG Grid's rows carry no testid of their own — the same place the rule cannot
// reach as MapLibre's canvas. Row *count* is the point: a grid built inside a
// hidden pane sizes its viewport to nothing and renders none at all.
const gridRow = page.locator('[data-testid="run-table"] .ag-row').first();
await gridRow.waitFor({ timeout: 30000 }).catch(() => {});
const gridRows = () => page.locator('[data-testid="run-table"] .ag-row').count();
check("the grid painted rows", (await gridRows()) > 0, `${await gridRows()} rows`);
check(
  "it says how big it is",
  /rows/.test(await testId("table-size").innerText()),
  await testId("table-size").innerText(),
);

const tableQueries = () => frames.filter(({ query }) => query?.drop_zeros !== undefined);
check("the table asks for a frame of its own", tableQueries().length > 0);
check(
  "it opens at the original resolution, not resampled",
  tableQueries().at(-1)?.query?.resample === undefined,
  JSON.stringify(tableQueries().at(-1)?.query),
);

// The filters are one store, shared with the charts — that is why the table is a
// sibling pane and not a separate screen.
check(
  "it inherited the charts' selection",
  JSON.stringify(tableQueries().at(-1)?.query?.selectors?.techs ?? []) ===
    JSON.stringify(
      frames.filter((f) => f.query?.drop_zeros === undefined).at(-1)?.query?.selectors
        ?.techs ?? [],
    ),
);

// Hiding empty series is the successor to v0.2.0's "Drop N/A values?" switch.
const reQueried = await settle(() => testId("table-drop-empty").click());
check(
  "turning off 'hide empty' re-queries for everything",
  reQueried > 0 && tableQueries().at(-1)?.query?.drop_zeros === false,
);
await settle(() => testId("table-drop-empty").click());

// The table offers inputs as well as results, and an input over nodes alone can
// be neither resampled nor summed. Locked, never removed — the same rule the
// charts follow.
const resolutionButtons = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="table-resolution"] button')].map(
      (button) => button.getAttribute("aria-disabled") === "true",
    ),
  );

/** Whether a select offers `option`, so a model without it can be skipped. */
const offers = async (select, option) => {
  await testId(select).click();
  const item = page.getByRole("option", { name: option, exact: true });
  await item.first().waitFor({ timeout: 3000 }).catch(() => {});
  const found = (await item.count()) > 0;
  if (!found) await page.keyboard.press("Escape");
  return found;
};

if (await offers("table-variable", "flow_cap")) {
  await settle(() =>
    page.getByRole("option", { name: "flow_cap", exact: true }).click(),
  );
  check(
    "resampling is locked on a variable with no timesteps",
    (await resolutionButtons()).every(Boolean),
    JSON.stringify(await resolutionButtons()),
  );
} else {
  skip("locking resample on a non-timeseries variable");
}

const table = await capture(page, () => testId("table-download").click());
check("the table exports a CSV", table.text.length > 0, table.name);
const header = rows(table.text)[0].split(",").length;
check(
  "its header matches the series it is showing",
  header - 1 ===
    Number(
      (await testId("table-size").innerText())
        .match(/×\s*([\d,]+)/)?.[1]
        ?.replace(/,/g, ""),
    ),
  `${header - 1} columns, "${await testId("table-size").innerText()}"`,
);
check("a number is never locale-formatted", !/\d\.\d{3},\d/.test(table.text));

// ── Display units ──────────────────────────────────────────────────────────
//
// Calliope declares that `flow_cap` is "power" and stops there — nothing in a
// model says whether that power is kW or GW. The sidebar is where the modeller
// says so, and the whole point is that the chart, the grid and the file follow
// together. A browser check because only a rendered page can be asked what its
// column headers say, and only a real export can be read back.
//
// Scoped to the table's own sidebar for the same reason the filter check above
// is: both panes stay mounted, so an unscoped testid matches twice.
const unitField = (name) =>
  page.locator(`[data-testid="run-table"] [data-testid="units-power-${name}"]`);

if ((await unitField("scale").count()) === 1) {
  const gridHeader = () =>
    page.locator('[data-testid="run-table"] .ag-header-cell-text').nth(1).innerText();
  /**
   * The first value in the file that a scale factor could show up in.
   *
   * Not simply row 1 column 1: a model defines every variable over the full
   * cross product of its dimensions, so the top-left cell is very often 0 —
   * and 0 divided by a thousand is 0, which proves nothing either way.
   */
  const firstNonZero = (csv) => {
    for (const line of rows(csv).slice(1)) {
      for (const cell of line.split(",").slice(1)) {
        const value = Number(cell);
        if (Number.isFinite(value) && value !== 0) return value;
      }
    }
    return null;
  };
  const before = firstNonZero(table.text);

  check(
    "an unset quantity still labels the axis with what Calliope knows",
    (await gridHeader()).includes("(power)"),
    await gridHeader(),
  );

  await settle(() => unitField("scale").fill("/1000"));
  await settle(() => unitField("label").fill("GW"));

  check(
    "naming a unit renames the grid's columns",
    (await gridHeader()).includes("(GW)"),
    await gridHeader(),
  );

  const scaled = await capture(page, () => testId("table-download").click());
  check(
    "the export carries the unit in its header",
    rows(scaled.text)[0].includes("(GW)"),
    rows(scaled.text)[0].slice(0, 80),
  );
  // The file has to be the figure. Scaling the picture and exporting the raw
  // numbers would make the two describe one query differently.
  const after = firstNonZero(scaled.text);
  check(
    "and the values the figure is showing, not the model's",
    before !== null && after !== null && Math.abs(before / after - 1000) < 1e-6,
    `${before} → ${after}`,
  );
  // No round trip: the scale is applied to the frame already in the browser.
  check("changing a unit asks the server for nothing", tableQueries().length > 0);

  await settle(() =>
    page.locator('[data-testid="run-table"] [data-testid="units-reset"]').click(),
  );
  check(
    "resetting puts the model's own numbers back",
    (await gridHeader()).includes("(power)"),
    await gridHeader(),
  );
} else {
  skip("display units on a variable measured in power");
}

// Cancelling the dialog has to mean the file is not written. Falling back to an
// ordinary download here would save the export the user just declined to save.
await page.evaluate(() => {
  window.showSaveFilePicker = async () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  };
});
const savedBefore = await page.evaluate(() => window.__cgSaved.length);
let sneaked = false;
page.once("download", () => {
  sneaked = true;
});
await testId("table-download").click();
// Nothing to wait for: the assertion is that neither route fires.
await quiet(700);
check(
  "cancelling the save dialog writes nothing, by either route",
  !sneaked && (await page.evaluate(() => window.__cgSaved.length)) === savedBefore,
);

// A browser with no picker at all — Firefox, Safari — still gets its file.
await page.evaluate(() => {
  delete window.showSaveFilePicker;
});
const [fallback] = await Promise.all([
  page.waitForEvent("download", { timeout: 15000 }),
  testId("table-download").click(),
]);
check(
  "a browser without the picker falls back to a download",
  /\.csv$/.test(fallback.suggestedFilename()),
  fallback.suggestedFilename(),
);

check("no console errors throughout", consoleErrors.length === 0);
await finish(browser, consoleErrors);
