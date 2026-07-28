/**
 * The results view, against a server opened on a solved model.
 *
 *   pixi run calliope-studio --no-browser --port 8792 path/to/results.nc
 *   npm run smoke -- http://127.0.0.1:8792
 *
 * Type-checking and unit tests cannot see the things that actually broke here:
 * an Arrow reader whose schema is only on the batch, an ECharts option merge
 * that never removes a series, a map layer that silently draws nothing. Each of
 * those looked fine until a real browser rendered it.
 *
 * Every selector is a `data-testid` or a role. The previous version drove this
 * screen through the component library's own class names, and every one of them
 * died the moment those controls were rewritten — a large part of what made that
 * migration expensive, and there is no reason to re-earn it.
 */
import { health, open, results } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";

const { check, skip, finish } = results();
const { browser, page, testId, consoleErrors, frames } = await open({
  viewport: { width: 1400, height: 1100 },
});

console.log(`Results view at ${BASE}`);
await health(BASE);

// The browser profile outlives a run, so a split dragged by the *last* one would
// otherwise decide where this one starts from — and a drag that begins at the
// minimum proves nothing.
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.evaluate(() => {
  localStorage.removeItem("calliope-studio.results.split");
  localStorage.removeItem("calliope-studio.results.collapsed");
});

// `/results` resolves whatever the server was opened on and replaces itself with
// a shell URL carrying a run tab.
await page.goto(`${BASE}/results`, { waitUntil: "networkidle" });
await testId("run-results").waitFor({ timeout: 20000 });
await page.waitForTimeout(4000);

check("landed in the shell", page.url().includes("tab=run"));
check("charts and map rendered", (await page.locator("canvas").count()) >= 2);
check("map mounted", (await page.locator(".maplibregl-map").count()) === 1);
check("filters rendered", (await testId("run-filters").count()) === 1);
check("no console errors on load", consoleErrors.length === 0);

// Switching to Duration changes the axis from time to category, which an
// ECharts option merge cannot absorb.
await testId("plot-type").getByText("Duration", { exact: true }).click();
await page.waitForTimeout(2500);
check(
  "duration order requested",
  frames.some(({ query }) => query?.order === "duration"),
);

// The technologies are split across a section per base tech — supply, storage,
// demand — plus one for the links. `data-dimension` is how the panel says which
// dataset dimension a section actually filters, and it is the only marker that
// does not depend on what a given model happens to contain.
await testId("plot-type").getByText("Bar", { exact: true }).click();
await page.waitForTimeout(1500);

const techSections = page.locator('[data-testid^="filter-"][data-dimension="techs"]');
const techSectionNames = await techSections.evaluateAll((nodes) =>
  nodes.map((node) => node.dataset.testid.replace("filter-", "")),
);
check("the technologies are split into sections", techSectionNames.length >= 2);
console.log(`  sections: ${techSectionNames.join(", ")}`);

// Deselecting a technology must remove its series, which merging never does.
const beforeDeselect = frames.length;
const first = techSections.first();
const techRows = first.locator('[role="checkbox"][data-testid]');
if (await techRows.count()) {
  await techRows.first().click();
} else {
  // A section with more members than fit as checkboxes gets the searchable
  // control instead.
  await first.getByRole("combobox").click();
  await page.getByRole("option").first().click();
  await page.keyboard.press("Escape");
}
await page.waitForTimeout(2500);
check("deselecting a technology re-queries", frames.length > beforeDeselect);

// The point of the split: one click clears a whole type. `None` then `All` on a
// section must move the chart in both directions.
const beforeNone = frames.length;
await first.getByText("None", { exact: true }).click();
await page.waitForTimeout(2500);
check("clearing a whole type re-queries", frames.length > beforeNone);
const clearedTechs = frames.at(-1)?.query?.selectors?.techs ?? [];

const beforeAll = frames.length;
await first.getByText("All", { exact: true }).click();
await page.waitForTimeout(2500);
check("restoring a whole type re-queries", frames.length > beforeAll);
check(
  "All restores more technologies than None left",
  (frames.at(-1)?.query?.selectors?.techs ?? []).length > clearedTechs.length,
);

// Transmission links get a section of their own: on a real model they outnumber
// the technologies five to one, and an undivided list is unusable. Theirs is the
// one tech section whose members are labelled by their endpoints.
if (await testId("filter-transmission").count()) {
  const linkRows = page.locator('[data-testid^="filter-transmission-"]');
  const beforeLink = frames.length;
  if (await linkRows.count()) {
    check(
      "links are named by their endpoints",
      (await linkRows.first().innerText()).includes("→"),
    );
    await linkRows.first().click();
  } else {
    const control = testId("filter-transmission").getByRole("combobox");
    await control.click();
    check(
      "links are named by their endpoints",
      (await page.getByRole("option").first().innerText()).includes("→"),
    );
    await page.getByRole("option").first().click();
    await page.keyboard.press("Escape");
  }
  await page.waitForTimeout(2500);
  check("deselecting a link re-queries", frames.length > beforeLink);
} else {
  skip("the transmission section (this model has no links)");
}

// None of those sections is a dimension — the dataset has no `supply` or
// `transmission` coordinate — and `filter_selectors` drops keys it does not know
// *silently*. A leak would not raise anything; the `techs` filter would just
// quietly lose most of its members.
const syntheticSections = techSectionNames.filter((name) => name !== "techs");
check(
  "no section name reaches the server as a selector key",
  frames.every(({ query }) =>
    syntheticSections.every((name) => query?.selectors?.[name] === undefined),
  ),
);

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
await page.waitForTimeout(800);

const afterDrag = await mapBox();
check("dragging the border resizes the map", afterDrag.height > beforeDrag.height + 60);

const storedSplit = () =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("calliope-studio.results.split") ?? "null"),
  );
check(
  "the split is remembered, keyed by panel count",
  (await storedSplit())?.["3"]?.length === 3,
);

// The two charts used to share one panel and a scrollbar, so the splitter could
// only say how much room the *map* got.
const chartsHandle = testId("results-charts-handle");
check("the two charts have a border of their own", (await chartsHandle.count()) === 1);

// ── Collapsing a figure ────────────────────────────────────────────────────
//
// Only the chevron and title are the target: the headers are dense with variable
// pickers, and a whole-strip target folds the figure away on a near miss.
/**
 * A figure's card height and the height of its own title bar.
 *
 * Measured rather than compared against a constant: the chart headers wrap onto a
 * second row at a narrow window, so what "collapsed" means in pixels is a
 * property of the header in front of you. A collapsed card is its title bar plus
 * the card's two hairlines, and nothing else.
 */
const figureBox = (figure) =>
  page.evaluate((name) => {
    const section = document
      .querySelector(`[data-testid="collapse-${name}"]`)
      .closest("section");
    const strip = section.firstElementChild;
    return {
      section: section.getBoundingClientRect().height,
      strip: strip.getBoundingClientRect().height,
      stripVisible:
        strip.getBoundingClientRect().bottom <=
        section.getBoundingClientRect().bottom + 0.5,
    };
  }, figure);

const expandedBox = await figureBox("static");
await testId("collapse-static").click();
await page.waitForTimeout(600);
const collapsedBox = await figureBox("static");
check(
  "collapsing leaves just the title bar",
  collapsedBox.section < expandedBox.section - 60 &&
    Math.abs(collapsedBox.section - (collapsedBox.strip + 2)) <= 1,
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
  (await figureBox("timeseries")).section > expandedBox.section,
);

// Two at once: collapsing one hands its space to a neighbour, and the splitter
// will hand it to a neighbour that is *itself* collapsed unless it is pinned.
await testId("collapse-timeseries").click();
await page.waitForTimeout(900);
const bothShut = {
  timeseries: await figureBox("timeseries"),
  static: await figureBox("static"),
};
check(
  "both charts can be collapsed at once",
  Math.abs(bothShut.timeseries.section - (bothShut.timeseries.strip + 2)) <= 1 &&
    Math.abs(bothShut.static.section - (bothShut.static.strip + 2)) <= 1,
  `time series ${Math.round(bothShut.timeseries.section)}, totals ${Math.round(bothShut.static.section)}`,
);
check(
  "the last open figure refuses to collapse",
  (await testId("collapse-map").getAttribute("aria-disabled")) === "true",
);
check(
  "all three title bars are the same height",
  Math.abs((await figureBox("map")).strip - bothShut.static.strip) <= 1,
  `map ${Math.round((await figureBox("map")).strip)}, totals ${Math.round(bothShut.static.strip)}`,
);

await testId("collapse-timeseries").click();
await page.waitForTimeout(600);

await page.reload({ waitUntil: "networkidle" });
await testId("run-results").waitFor({ timeout: 20000 });
await page.waitForTimeout(3000);
const reloadedBox = await figureBox("static");
check(
  "a collapsed figure stays collapsed across a reload",
  Math.abs(reloadedBox.section - (reloadedBox.strip + 2)) <= 1,
);

await testId("collapse-static").click();
await page.waitForTimeout(600);
check("expanding brings it back", (await figureBox("static")).section > 60);

// ── The map's encoding channels ────────────────────────────────────────────
const pickChannel = async (channel, option) => {
  await testId(`map-${channel}-variable`).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await page.waitForTimeout(2500);
};

const nodeQueries = () => frames.filter(({ query }) => query?.index === "nodes");
check("the map asks for a nodes-indexed frame", nodeQueries().length > 0);

const colorOption = await testId("map-size-variable").innerText();
await pickChannel("color", colorOption.trim());
check(
  "the colour channel issues a second nodes-indexed query",
  nodeQueries().filter(({ query }) => query?.sum_by === "techs").length >= 2,
);
check("the legend appears", (await testId("map-legend").count()) === 1);

await pickChannel("pie", colorOption.trim());
check(
  "a pie keeps the technologies apart",
  nodeQueries().some(({ query }) => query?.sum_by === undefined),
);
check(
  "a pie takes over the colour channel",
  await testId("map-color-variable").isDisabled(),
);
check("pies are drawn as markers", (await page.locator(".maplibregl-marker").count()) > 0);

await pickChannel("pie", "No pie");
await pickChannel("color", "No colour");
await pickChannel("size", "No size");
check(
  "every channel off leaves the nodes alone",
  (await page.locator(".maplibregl-marker").count()) === 0 &&
    (await testId("map-legend").count()) === 0,
);
await pickChannel("size", colorOption.trim());

// ── Aggregating the totals chart ───────────────────────────────────────────
//
// Summing the nodes away is what turns this into model-wide totals by
// technology, which had no answer here at all.
const sumBefore = frames.length;
await testId("static-sum-by").getByText("Sum nodes", { exact: true }).click();
await page.waitForTimeout(2500);
check(
  "the totals chart can sum the nodes away",
  frames.length > sumBefore &&
    frames.some(({ query }) => query?.sum_by === "nodes" && !query?.resample),
);

// Summing the nodes away puts the technologies on the axis, and colour has to
// follow them there: it was read off the series only, so every bar came out in
// the same ordinal ramp — the one thing a chart of eight technologies must not
// be, and a different colour from the same technology on the map beside it.
const paintedColours = () =>
  page.evaluate(() => {
    const canvas = [...document.querySelectorAll("section")]
      .find((s) => s.querySelector('[data-testid="static-sum-by"]'))
      .querySelector("canvas");
    const { data } = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 250) continue;
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      // Saturated only: the grid, the axis text and the background are grey.
      if (Math.max(r, g, b) - Math.min(r, g, b) < 30) continue;
      seen.add(`#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`);
    }
    return [...seen];
  });

const techColours = await page.evaluate(async () => {
  const handle = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name.match(/\/api\/results\/([^/]+)\//))
    .find(Boolean)?.[1];
  const body = await (await fetch(`/api/results/${handle}/catalog/`)).json();
  return Object.values(body.colors).map((hex) => hex.toLowerCase());
});
const painted = new Set(await paintedColours());
const matched = techColours.filter((hex) => painted.has(hex));
check(
  "aggregated bars take the model's technology colours",
  matched.length >= 3,
  `${matched.length} of ${new Set(techColours).size} tech colours painted`,
);

await testId("static-sum-by").getByText("No sum", { exact: true }).click();
await page.waitForTimeout(2500);
const unaggregated = new Set(await paintedColours());
check(
  "with nothing summed, colour stays on the series",
  techColours.filter((hex) => unaggregated.has(hex)).length === 0,
);
await testId("static-sum-by").getByText("Sum nodes", { exact: true }).click();
await page.waitForTimeout(2000);

// An option a variable cannot honour is locked and says why — never removed. A
// toggle group that loses buttons as the variable changes reads as a broken
// control, which is exactly how the first version of this was read.

/** Whether a select offers `option`, so a model without it can be skipped. */
const offers = async (select, option) => {
  await testId(select).click();
  await page.waitForTimeout(300);
  const found =
    (await page.getByRole("option", { name: option, exact: true }).count()) > 0;
  if (!found) await page.keyboard.press("Escape");
  return found;
};

/** Picks an option in a select that is already open, from `offers`. */
const pickOpen = async (option) => {
  await page.getByRole("option", { name: option, exact: true }).click();
  await page.waitForTimeout(1500);
};

const sumButtons = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="static-sum-by"] button')].map(
      (button) => ({
        label: button.textContent.trim(),
        locked: button.getAttribute("aria-disabled") === "true",
        pressed: button.getAttribute("aria-pressed") === "true",
      }),
    ),
  );

check(
  "all three sum options are offered",
  JSON.stringify((await sumButtons()).map((button) => button.label)) ===
    JSON.stringify(["No sum", "Sum nodes", "Sum techs"]),
  JSON.stringify(await sumButtons()),
);

// `total_levelised_cost` is `(costs, carriers)` — neither dimension to sum.
if (await offers("static-variable", "total_levelised_cost")) {
  await pickOpen("total_levelised_cost");
  const locked = await sumButtons();
  check(
    "an option the variable cannot honour is locked, not removed",
    locked.length === 3 &&
      !locked[0].locked &&
      locked[1].locked &&
      locked[2].locked,
    JSON.stringify(locked),
  );

  check(
    "the toggle shows what the chart is actually doing",
    locked[0].pressed && !locked[1].pressed && !locked[2].pressed,
    JSON.stringify(locked),
  );

  // Forced, because `aria-disabled` already stops an ordinary click and a
  // browser refusing it says nothing about the handler. This asserts the second
  // line of defence: even a click that lands issues no query.
  const lockedBefore = frames.length;
  await testId("static-sum-by")
    .getByText("Sum nodes", { exact: true })
    .click({ force: true });
  await page.waitForTimeout(1200);
  check(
    "even a forced click on a locked option changes nothing",
    frames.length === lockedBefore,
  );
} else {
  skip("locking an inapplicable sum (no such variable on this model)");
}

// The sub-views of a run tab. Results has to survive a trip to the log, or
// coming back would rebuild the map and refetch every frame.
if (await testId("run-subtab-log").isEnabled()) {
  await testId("run-subtab-log").click();
  await page.waitForTimeout(500);
  check("log sub-view opens", (await testId("run-log").count()) === 1);

  const beforeReturn = frames.length;
  await testId("run-subtab-results").click();
  await page.waitForTimeout(1500);
  check("returning to results issues no new frame request", frames.length === beforeReturn);
  check("results pane was kept alive", (await page.locator("canvas").count()) >= 2);
} else {
  // A bare `.nc` has no run behind it, so it has no log and nothing was frozen.
  skip("run sub-views (these results have no run behind them)");
}

// Both themes. The assertion is on the token itself: for most of this project's
// life `tokens.css` was never imported at all, so this returned the same value
// in both modes.
const themeValue = () =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--cg-bg").trim(),
  );
const lightBg = await themeValue();
// Measured here rather than reusing the post-drag height: collapsing and
// re-expanding a figure in between moved the map, so that baseline is stale.
const beforeTheme = await mapBox();
await page.evaluate(() => localStorage.setItem("calliope-studio.theme", "dark"));
await page.reload({ waitUntil: "networkidle" });
await testId("run-results").waitFor({ timeout: 20000 });
await page.waitForTimeout(2000);

// The reload is here for the theme, so the persistence round trip comes free.
const reloaded = await mapBox();
check(
  "the dragged split survives a reload",
  Math.abs(reloaded.height - beforeTheme.height) < 24,
  `${beforeTheme.height} → ${reloaded.height}`,
);

check("the theme token actually changes", Boolean(lightBg) && lightBg !== (await themeValue()));
check(
  "the root carries the dark attribute",
  (await page.getAttribute("html", "data-cg-theme")) === "dark",
);

// MapLibre's own chrome is created outside the Vue tree and styled by a
// stylesheet we override. ModelMap is lazily loaded, so its copy of
// maplibre-gl.css used to arrive in a *later* chunk and win on order alone,
// leaving a white control box glowing on a dark map.
const controlBackground = await page.evaluate(() => {
  const control = document.querySelector(".maplibregl-ctrl-group");
  return control ? getComputedStyle(control).backgroundColor : null;
});
check(
  "the map's controls follow the theme",
  Boolean(controlBackground) && !/^rgb\(255, 255, 255\)$/.test(controlBackground),
);

// The basemap itself, not just the chrome around it. It is a vector style built
// from the `--cg-map-*` tokens, so dark mode is a real style rather than the
// dimmed raster it used to be — and if the tokens ever stop resolving, MapLibre
// silently falls back to the hard-coded light values in `lib/basemap.ts` and the
// map goes on looking finished while being wrong.
const basemap = await page.evaluate(() => {
  const map = window.__cgMap;
  return {
    land: map?.getPaintProperty("land", "background-color") ?? null,
    labels: map?.getPaintProperty("place-city", "text-color") ?? null,
    raster: map?.getLayoutProperty("osm", "visibility") ?? null,
  };
});
const luminance = (colour) => {
  const [red, green, blue] = (colour ?? "").match(/\d+/g)?.map(Number) ?? [255, 255, 255];
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
};
check(
  "the basemap is a real dark style, not a dimmed light one",
  luminance(basemap.land) < 0.25 && luminance(basemap.labels) > 0.35,
  `land ${basemap.land}, labels ${basemap.labels}`,
);
check(
  "the vector tiles loaded, so the raster fallback stayed down",
  basemap.raster === "none",
  String(basemap.raster),
);

await page.screenshot({ path: "/tmp/calliope-studio-smoke.png", fullPage: true });
console.log("screenshot: /tmp/calliope-studio-smoke.png");

await finish(browser, consoleErrors);
