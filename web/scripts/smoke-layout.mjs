/**
 * How the three figures divide the height: dragging, folding, and the layouts.
 *
 *   npm run smoke:layout -- http://127.0.0.1:8792
 *
 * The layouts exist because there used to be one stored geometry, and the
 * splitter rewrites it on every drag *and* on every collapse-driven
 * redistribution — so folding a figure away destroyed the sizes of the
 * arrangement it was folded out of, and switching figures on and off meant
 * re-dragging the boundaries every time.
 *
 * Nothing here sleeps for a duration. A splitter settles over more than one
 * frame — reka emits on the next tick, and the view applies a layout twice, a
 * frame apart, on purpose — so what is waited for is the geometry to stop
 * changing. `stable` is that, and it typically returns in ~150ms where the fixed
 * sleeps it replaces were 1500 each.
 */
import { results } from "./harness.mjs";
import {
  baseFrom,
  figureBox,
  figureGeometry,
  isCollapsedCard,
  openResults,
} from "./results-page.mjs";

const BASE = baseFrom(process.argv);
const { check, finish } = results("layout");
const { browser, page, testId, consoleErrors, stable, framesIdle, mapReady } =
  await openResults(BASE);

console.log(`Figure layout at ${BASE}`);

/** Waits for the panels to stop moving, whatever set them off. */
const settled = () => stable(() => figureGeometry(page));

const box = (figure) => figureBox(page, figure);
const storedGeometry = () =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("calliope-studio.results.geometry") ?? "null"),
  );

await settled();

// ── Dragging ───────────────────────────────────────────────────────────────
//
// The map was a fixed 300px, which on a model spanning a country is not enough
// to see it by.
const mapBox = () => page.locator(".maplibregl-map").boundingBox();
const beforeDrag = await mapBox();
const handle = testId("results-split-handle");
check("the map/charts border has a handle", (await handle.count()) === 1);

const handleBox = await handle.boundingBox();
await page.mouse.move(
  handleBox.x + handleBox.width / 2,
  handleBox.y + handleBox.height / 2,
);
await page.mouse.down();
await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 160, {
  steps: 12,
});
await page.mouse.up();
await settled();

check(
  "dragging the border resizes the map",
  (await mapBox()).height > beforeDrag.height + 60,
);
check(
  "the drag is remembered, against the layout on screen",
  (await storedGeometry())?.stacked?.sizes?.main?.length === 2,
);

// The two charts used to share one panel and a scrollbar, so the splitter could
// only say how much room the *map* got.
check(
  "the two charts have a border of their own",
  (await testId("results-charts-handle").count()) === 1,
);

// ── Collapsing a figure ────────────────────────────────────────────────────
//
// Only the chevron and title are the target: the headers are dense with variable
// pickers, and a whole-strip target folds the figure away on a near miss.
const expandedBox = await box("static");
await testId("collapse-static").click();
await settled();
const collapsedBox = await box("static");
check(
  "collapsing leaves just the title bar",
  collapsedBox.section < expandedBox.section - 60 && isCollapsedCard(collapsedBox),
  `${Math.round(expandedBox.section)} → ${Math.round(collapsedBox.section)}, strip ${Math.round(collapsedBox.strip)}`,
);
check(
  "the collapsed title bar is still whole, so its controls still work",
  collapsedBox.stripVisible,
);
// The neighbour, not the map: a splitter hands a collapsing panel's space to the
// panel next to it, and the totals chart's neighbour is the time series.
check(
  "the figure next to it takes the room",
  (await box("timeseries")).section > expandedBox.section,
);

// Two at once: collapsing one hands its space to a neighbour, and the splitter
// will hand it to a neighbour that is *itself* collapsed unless it is pinned.
await testId("collapse-timeseries").click();
await settled();
const bothShut = { timeseries: await box("timeseries"), static: await box("static") };
check(
  "both charts can be collapsed at once",
  isCollapsedCard(bothShut.timeseries) && isCollapsedCard(bothShut.static),
  `time series ${Math.round(bothShut.timeseries.section)}, totals ${Math.round(bothShut.static.section)}`,
);
check(
  "the last open figure refuses to collapse",
  (await testId("collapse-map").getAttribute("aria-disabled")) === "true",
);
check(
  "all three title bars are the same height",
  Math.abs((await box("map")).strip - bothShut.static.strip) <= 1,
  `map ${Math.round((await box("map")).strip)}, totals ${Math.round(bothShut.static.strip)}`,
);

await testId("collapse-timeseries").click();
await settled();

await page.reload({ waitUntil: "domcontentloaded" });
await testId("run-results").waitFor({ timeout: 30000 });
await mapReady().catch(() => false);
await framesIdle();
await settled();
check("a collapsed figure stays collapsed across a reload", isCollapsedCard(await box("static")));

await testId("collapse-static").click();
await settled();
check("expanding brings it back", (await box("static")).section > 60);

// ── Layouts ────────────────────────────────────────────────────────────────
check(
  "the layouts have a strip of their own",
  (await testId("results-layout-bar").count()) === 1,
);

// Stamped so a *rearranged* map can be told from a rebuilt one. Flipping the
// direction of a mounted splitter is the whole reason this is one panel tree and
// not two behind a `v-if`: a rebuild would lose the viewport the user panned to,
// and it would not throw or log anything to say so.
await page.evaluate(() => {
  window.__cgMap.__smokeStamp = "kept";
});

const stackedBefore = await storedGeometry();

await testId("results-layout-beside").click();
await settled();

// The cards, not the map canvas: the canvas sits below a header that wraps to
// two rows at half the width, so its top is not the figure's.
const beside = await page.evaluate(() => {
  const map = document
    .querySelector('[data-testid="figure-map"]')
    .getBoundingClientRect();
  const chart = document
    .querySelector('[data-testid="figure-timeseries"]')
    .getBoundingClientRect();
  return {
    mapRight: map.right,
    chartLeft: chart.left,
    mapTop: map.top,
    chartTop: chart.top,
  };
});
check(
  "beside puts the map next to the charts, not above them",
  beside.mapRight <= beside.chartLeft + 2 &&
    Math.abs(beside.mapTop - beside.chartTop) < 24,
  `map ends at ${Math.round(beside.mapRight)}, charts start at ${Math.round(beside.chartLeft)}`,
);
check(
  "the map is rearranged, not rebuilt",
  await page.evaluate(() => window.__cgMap?.__smokeStamp === "kept"),
);
// A horizontally collapsed card would need a horizontal title bar, which is not
// a thing; side by side the map is put away by choosing another layout.
check("side by side, the map offers no chevron", (await testId("collapse-map").count()) === 0);

await testId("results-layout-stacked").click();
await settled();
check(
  "switching away and back leaves a layout exactly as it was",
  JSON.stringify((await storedGeometry())?.stacked) ===
    JSON.stringify(stackedBefore?.stacked),
);

await testId("results-layout-totals").click();
await settled();
check(
  "the totals layout folds the other two away",
  isCollapsedCard(await box("map")) &&
    isCollapsedCard(await box("timeseries")) &&
    !isCollapsedCard(await box("static")),
);
check(
  "an untouched layout offers no reset",
  (await testId("results-layout-reset").count()) === 0,
);

await testId("collapse-map").click();
await settled();
check(
  "a layout that has been changed offers to go back",
  (await testId("results-layout-reset").count()) === 1,
);
await testId("results-layout-reset").click();
await settled();
check(
  "reset puts it back",
  isCollapsedCard(await box("map")) &&
    (await testId("results-layout-reset").count()) === 0,
);

await testId("results-layout-stacked").click();
await settled();
check(
  "the stacked layout still has all three open",
  !isCollapsedCard(await box("map")) &&
    !isCollapsedCard(await box("timeseries")) &&
    !isCollapsedCard(await box("static")),
);

// The drag from the top of this file, still there after everything since.
const beforeReload = await mapBox();
await page.reload({ waitUntil: "domcontentloaded" });
await testId("run-results").waitFor({ timeout: 30000 });
await mapReady().catch(() => false);
await framesIdle();
await settled();
check(
  "the dragged split survives a reload",
  Math.abs((await mapBox()).height - beforeReload.height) < 24,
  `${Math.round(beforeReload.height)} → ${Math.round((await mapBox()).height)}`,
);

check("no console errors throughout", consoleErrors.length === 0);
await finish(browser, consoleErrors);
