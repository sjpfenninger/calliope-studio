/**
 * The README's screenshots, taken from the running application.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run screenshots http://127.0.0.1:8791 results out/
 *   pnpm run screenshots http://127.0.0.1:8791 editor  out/
 *
 * Both modes want the same server: a workspace, with a model in it.
 *
 * A browser check in every respect except that it asserts almost nothing: it
 * drives the app to a state worth photographing and writes a PNG. It is here
 * rather than in a workflow file because the hard part is not the capture, it is
 * knowing when the page has *finished* — the results view applies its layout
 * twice a frame apart on purpose, MapLibre paints tiles whenever they arrive,
 * and ECharts animates its first render. All three are observable, and the
 * `smoke-*` checks already had to learn how, so this waits on exactly the
 * conditions they wait on.
 *
 * The same house rule holds: **nothing sleeps for a guessed duration.** A shot
 * taken after `waitForTimeout(3000)` is a half-painted map on a loaded runner,
 * and the failure ships to the README rather than to a test log.
 *
 * The two guards that *are* assertions exist because a broken screenshot is
 * silent — a blank pane and a full one are the same number of bytes to a
 * workflow. So a map canvas of no size, or a page that logged an error, fails
 * the run rather than publishing the picture.
 *
 * It never writes to the model. `map-edit.mjs` edits and restores in a
 * `finally`; this one only ever looks.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { health, open, requireMode, trackRequests, until } from "./harness.mjs";
import { figureGeometry, forceTheme } from "./results-page.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";
const MODE = process.argv[3] ?? "results";
const OUT = process.argv[4] ?? "screenshots";

/**
 * Wider than it is tall, because a README renders it into a column.
 *
 * The results view stacks two charts beside the map, so it needs the height; at
 * 16:9 the lower chart is a letterbox. 3:2 is the compromise, and it is the same
 * for both modes so the two pictures sit together on the page.
 */
const VIEWPORT = { width: 1440, height: 960 };

/** Both, so the README can follow the reader's own theme. */
const THEMES = ["light", "dark"];

const problems = [];

/** A console error in a picture nobody has looked at yet is worth failing over. */
function report(name, consoleErrors) {
  if (!consoleErrors.length) return;
  problems.push(`${name}: ${consoleErrors.length} console error(s)`);
  consoleErrors.slice(0, 5).forEach((line) => console.log(`      ${line}`));
}

/**
 * Writes the shot, having first checked there is something on it.
 *
 * The size guard is the nodes map's own regression: it rendered 0px high for as
 * long as it existed, and a zero-height map throws nothing and logs nothing.
 */
async function shoot(page, name) {
  const canvas = page.locator(".maplibregl-canvas").first();
  const box = await canvas.boundingBox().catch(() => null);
  if (!box || box.width < 200 || box.height < 100) {
    const size = box ? `${box.width}×${box.height}` : "absent";
    problems.push(`${name}: the map canvas is ${size}`);
  }

  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path });
  console.log(`  wrote ${path}`);
}

/**
 * The results view, on a run of the model the server was opened on.
 *
 * A workspace with a real run in it, rather than a bare `.nc` — which is the
 * other way to reach this view and was the obvious way to shoot it. It is not:
 * opening a `.nc` directly puts the app in `results` mode, where there is no
 * model and the sidebar correctly says so, and "No model open" in the top-left
 * corner of the first picture in the README is not what this application does.
 * A run also fills the Runs list and dates the picture as something that
 * happened, which is the point of the view.
 *
 * The first theme solves for real and the second finds that run waiting, so the
 * solver is paid for once.
 */
async function results(theme) {
  const payload = requireMode(await health(BASE), "workspace", BASE);

  const { browser, page, testId, stable, mapReady, framesIdle, consoleErrors } =
    await open({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  await forceTheme(page, theme);

  const calls = trackRequests(page, (request) => request.url().includes("/api/"));

  await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Runs" }).click();
  await testId("start-run").waitFor({ timeout: 30000 });

  // The list arrives after the button does, and asking before it lands reads as
  // "no runs" — which is how the second theme came to solve the model a second
  // time, for three minutes, to photograph a run that was already sitting there.
  await calls.idle();

  const solved = page
    .locator('[data-testid="run-item"]')
    .filter({ has: page.locator('[data-status="success"]') })
    .first();

  if (await solved.count()) {
    // The row is a `div`; the name inside it is the button that opens the run.
    // And a run opened from the list lands on its *log* — only a live one moves
    // itself to the charts when the handle arrives, so waiting for the charts
    // without asking for them waits for something that will never happen.
    await solved.locator('[data-testid="run-open"]').click();
    const graphs = testId("run-subtab-results");
    await graphs.waitFor({ timeout: 60000 });
    await graphs.click();
    await testId("run-results").waitFor({ timeout: 120000 });
  } else {
    // Solves for real, so it takes as long as the model does; the tab opens on
    // the log and moves itself to the charts when the handle arrives, which is
    // the only thing worth waiting for.
    console.log("  no finished run to photograph; solving one");
    await testId("start-run").click();
    await testId("run-results").waitFor({ timeout: 600000 });
  }

  await page.locator("canvas").first().waitFor({ timeout: 60000 });
  await mapReady().catch(() => false);
  await framesIdle();

  await compose(page, testId, framesIdle);

  // The layout is applied twice, a frame apart — every constraint is a
  // percentage of a measured box, and mid-switch the measurements are one frame
  // behind. Between the two passes the panels are at the wrong sizes.
  await stable(() => figureGeometry(page));

  report(`results-${theme}`, consoleErrors);
  await shoot(page, `results-${theme}`);
  await browser.close();
}

/**
 * Turns the view's defaults into a picture worth publishing.
 *
 * Two changes, both because the defaults are tuned for answering "did this
 * work" rather than for being looked at:
 *
 * - **The map's colour channel**, which is off. Size alone is one blue circle
 *   per node; size *and* colour is the encoding the map exists for.
 * - **The time series' resolution.** The chart opens on the coarsest the model
 *   allows, which is the cheapest query and the right default. But the model
 *   this photographs is Calliope's stock `national_scale`, and that is five
 *   days — so the default daily series is *five bars*, with an x-axis reading
 *   "2 3 4 5". Unresampled it is 120 hourly points and looks like a chart.
 *
 * Both are verified rather than clicked and hoped for. An earlier version of
 * this selected the resolution by `role="radio"`, which these buttons are not,
 * so it matched nothing, returned quietly, and published the five bars — the
 * whole failure being that nothing anywhere said it had not worked.
 */
async function compose(page, testId, framesIdle) {
  await pickResolution(page, testId, framesIdle);
  await colourTheMap(page, testId, framesIdle);

  // A select that has just closed leaves a popper animating, and it photographs
  // as a grey smear over whatever is under it.
  await until(
    async () => (await page.locator("[data-radix-popper-content-wrapper]").count()) === 0,
    { timeout: 5000 },
  );
}

/** The unresampled series, if this model offers one. */
async function pickResolution(page, testId, framesIdle) {
  // `ToggleGroupItem` renders a button carrying `data-state`, not a radio.
  const original = testId("resolution").getByRole("button", {
    name: "Original",
    exact: true,
  });
  if (!(await original.count())) {
    problems.push("the time series offers no unresampled resolution");
    return;
  }

  await original.click();
  await framesIdle();

  if ((await original.getAttribute("data-state")) !== "on") {
    problems.push("the unresampled resolution did not take");
  }
}

/** Colours the map by whatever it is already sizing itself with. */
async function colourTheMap(page, testId, framesIdle) {
  const colour = testId("map-color-variable");
  if (!(await colour.count())) {
    problems.push("the map has no colour channel to turn on");
    return;
  }

  const label = (await testId("map-size-variable").innerText()).trim();
  await colour.click();
  const option = page.getByRole("option", { name: label, exact: true });
  if (!(await option.count())) {
    problems.push(`no "${label}" to colour by`);
    await page.keyboard.press("Escape");
    return;
  }

  await option.click();
  await framesIdle();
  if ((await colour.innerText()).trim() !== label) {
    problems.push("the map's colour channel did not take");
  }
}

/**
 * The nodes editor, which opens on the map, with one node selected.
 *
 * Selected, because the pane under the map is a third of the picture and
 * unselected it holds one line of instructions. Selecting is ordinary UI state
 * and writes nothing — unlike `map-edit.mjs`, which drags and then puts the file
 * back in a `finally`; this script must never touch the model.
 *
 * The click goes through `window.__cgMap.project()` rather than the tree,
 * because MapLibre draws nodes to a canvas and there is no element to click.
 * That seam is the one place these scripts are allowed to reach past
 * `data-testid`, and it is why the node names do not have to be known here.
 */
async function editor(theme) {
  const payload = requireMode(await health(BASE), "workspace", BASE);

  const { browser, page, testId, stable, mapReady, consoleErrors } = await open({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  });
  await forceTheme(page, theme);

  const calls = trackRequests(page, (request) => request.url().includes("/api/"));

  await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
  await testId("model-tree").waitFor({ timeout: 30000 });
  await calls.idle();

  await calls.settle(() =>
    page.getByRole("treeitem", { name: /^nodes$/i }).first().click(),
  );
  await testId("editor-map").waitFor({ timeout: 30000 });

  // The element exists before MapLibre has a style, and `project()` on a map that
  // has not loaded returns a point for a viewport that is about to change.
  await mapReady();
  await calls.idle();
  await stable(() => page.locator(".maplibregl-canvas").first().boundingBox());

  await selectANode(page, testId, `${BASE}/api/versions/${payload.workspace_id}/geo/`);

  report(`editor-${theme}`, consoleErrors);
  await shoot(page, `editor-${theme}`);
  await browser.close();
}

/** Clicks whichever node the map has placed nearest its own centre. */
async function selectANode(page, testId, geoUrl) {
  const geo = await (await fetch(geoUrl)).json();
  const placed = (geo.nodes?.features ?? []).filter(
    (feature) => feature.geometry?.coordinates?.length === 2,
  );
  if (!placed.length) {
    problems.push("the model has no placed nodes to select");
    return;
  }

  const canvas = page.locator(".maplibregl-canvas").first();
  const box = await canvas.boundingBox();
  const points = await page.evaluate(
    (pairs) => pairs.map((pair) => window.__cgMap.project(pair)),
    placed.map((feature) => feature.geometry.coordinates),
  );

  // The nearest to the middle: the corners of a fitted bounds are where a node
  // sits half under the zoom control or the attribution strip.
  const middle = { x: box.width / 2, y: box.height / 2 };
  const nearest = points
    .map((point) => ({ point, d: Math.hypot(point.x - middle.x, point.y - middle.y) }))
    .sort((a, b) => a.d - b.d)[0];

  await page.mouse.click(box.x + nearest.point.x, box.y + nearest.point.y);
  const shown = await testId("node-name")
    .waitFor({ timeout: 15000 })
    .then(() => true, () => false);
  if (!shown) problems.push("clicking a node opened no form");
}

const MODES = { results, editor };
const capture = MODES[MODE];
if (!capture) {
  console.error(`Unknown mode "${MODE}". Expected one of: ${Object.keys(MODES).join(", ")}`);
  process.exit(2);
}

await mkdir(OUT, { recursive: true });
console.log(`Screenshotting the ${MODE} view at ${BASE}`);

// Sequentially, and in a fresh context each time: the theme is pinned by an init
// script, so one page cannot hold both, and two browsers racing for the same
// single-process server is how the smoke runner learned to cap itself at two.
for (const theme of THEMES) await capture(theme);

if (problems.length) {
  console.error("\nthese shots are not fit to publish:");
  problems.forEach((line) => console.error(`  ${line}`));
  process.exit(1);
}
console.log(`\n${THEMES.length} shot(s) of the ${MODE} view, in ${OUT}/`);
