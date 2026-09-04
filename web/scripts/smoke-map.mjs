/**
 * The map: its three encoding channels, its legend, and its basemap in the dark.
 *
 *   pnpm run smoke:map http://127.0.0.1:8792
 *
 * All three channels drawn at once is the case worth checking, because each is
 * its own query and a marker sized from the wrong series is a perfectly
 * plausible-looking marker.
 */
import { results } from "./harness.mjs";
import { baseFrom, openResults } from "./results-page.mjs";

const BASE = baseFrom(process.argv);
const { check, skip, finish } = results("map");
const {
  browser,
  page,
  testId,
  consoleErrors,
  frames,
  settle,
  framesIdle,
  mapReady,
  until,
  stable,
} = await openResults(BASE);

console.log(`Map at ${BASE}`);

/** Picks a variable for one channel and waits for the frame it asks for. */
const pickChannel = (channel, option) =>
  settle(
    async () => {
      await testId(`map-${channel}-variable`).click();
      await page.getByRole("option", { name: option, exact: true }).click();
    },
    // Switching a channel off asks for nothing; the wait is then only for the
    // traffic already on the wire to drain.
    { expect: /^No /.test(option) ? 0 : 1 },
  );

const nodeQueries = () => frames.filter(({ query }) => query?.index === "nodes");
check("the map asks for a nodes-indexed frame", nodeQueries().length > 0);

const variable = (await testId("map-size-variable").innerText()).trim();

await pickChannel("color", variable);
check(
  "the colour channel issues a second nodes-indexed query",
  nodeQueries().filter(({ query }) => query?.sum_by === "techs").length >= 2,
);
check("the legend appears", (await testId("map-legend").count()) === 1);

await pickChannel("pie", variable);
await page.locator(".maplibregl-marker").first().waitFor({ timeout: 15000 });
check(
  "a pie keeps the technologies apart",
  nodeQueries().some(({ query }) => query?.sum_by === undefined),
);
check(
  "a pie takes over the colour channel",
  await testId("map-color-variable").isDisabled(),
);
check("pies are drawn as markers", (await page.locator(".maplibregl-marker").count()) > 0);

// A donut and a circle are two ways of drawing the same node, and the pie
// channel used to settle that by hiding the `nodes` layer outright. That takes
// its features out of `queryRenderedFeatures` too — which is what the
// layer-scoped hover and click handlers are built on — so under pies a node had
// no popup, could not be selected, and could not tell a link click that it was
// sitting on top of it. Which nodes draw a circle is a paint question now.
const layered = await page.evaluate(() => {
  const map = window.__cgMap;
  const visibility = map.getLayoutProperty("nodes", "visibility") ?? null;
  const { data } = map.getSource("nodes").serialize();
  let queryable = 0;
  for (const feature of data.features) {
    if (feature.geometry?.type !== "Point") continue;
    const point = map.project(feature.geometry.coordinates);
    if (map.queryRenderedFeatures(point, { layers: ["nodes"] }).length) queryable += 1;
  }
  return { visibility, queryable };
});
check(
  "the node layer stays visible under pies",
  layered.visibility !== "none",
  String(layered.visibility),
);
check(
  "so a node wearing a donut is still a rendered feature",
  layered.queryable > 0,
  `${layered.queryable} nodes answer a query`,
);

await pickChannel("pie", "No pie");
await pickChannel("color", "No colour");
await pickChannel("size", "No size");
await page.waitForFunction(
  () => document.querySelectorAll(".maplibregl-marker").length === 0,
  undefined,
  { timeout: 15000 },
);
check(
  "every channel off leaves the nodes alone",
  (await page.locator(".maplibregl-marker").count()) === 0 &&
    (await testId("map-legend").count()) === 0,
);
await pickChannel("size", variable);

// ── Selecting a node, and putting the selection back ───────────────────────
//
// The selection narrows every chart query, so the only way out of it is the
// Clear beside the layout bar's summary — the map itself offers no "none".
// Re-picking a channel re-sets the node source, and until MapLibre has
// rendered the new data a click on a node's projected point hits nothing —
// `idle` is the map's own word for "everything asked for is drawn".
await page.evaluate(
  () =>
    new Promise((resolve) => {
      const map = window.__cgMap;
      if (map.loaded() && !map.isMoving()) resolve();
      else map.once("idle", resolve);
    }),
);
// `idle` answers only for data the map has already been handed, and the
// payload lands *after* `settle` returns: the request is done, but the Arrow
// batches are parsed and applied in later tasks, and `setData` empties the
// layer until the worker has re-tiled it. A click inside that window queries
// nothing. So the click waits for a node to be rendered under its point, and a
// click that still finds nothing — the payload arriving between that test and
// the press — is taken again. Under coverage recording the window was wide
// enough to hit on every parallel run; nothing about it is specific to the
// recording.
const projectNode = () =>
  page.evaluate(() => {
    const map = window.__cgMap;
    const { data } = map.getSource("nodes").serialize();
    const canvas = map.getCanvas();
    for (const feature of data.features) {
      if (feature.geometry?.type !== "Point") continue;
      const point = map.project(feature.geometry.coordinates);
      const inside =
        point.x > 4 &&
        point.y > 4 &&
        point.x < canvas.clientWidth - 4 &&
        point.y < canvas.clientHeight - 4;
      if (inside) return { x: point.x, y: point.y };
    }
    return null;
  });
const nodeRenderedAt = (point) =>
  page.evaluate(
    ({ x, y }) => window.__cgMap.queryRenderedFeatures([x, y], { layers: ["nodes"] }).length > 0,
    point,
  );
const nodePoint = await stable(projectNode);
if (nodePoint) {
  const canvasBox = await page.locator(".maplibregl-canvas").first().boundingBox();
  let narrowed = false;
  for (let attempt = 0; attempt < 3 && !narrowed; attempt += 1) {
    await until(() => nodeRenderedAt(nodePoint));
    await page.mouse.click(canvasBox.x + nodePoint.x, canvasBox.y + nodePoint.y);
    narrowed = await until(async () => (await testId("clear-map-nodes").count()) === 1, {
      timeout: 5000,
    });
  }
  check("clicking a node narrows the charts to it", narrowed);
}
if (nodePoint && (await testId("clear-map-nodes").count()) === 1) {
  await testId("clear-map-nodes").click();
  const cleared = await until(
    async () => (await testId("clear-map-nodes").count()) === 0,
    { timeout: 15000 },
  );
  check("and Clear puts the whole model back", cleared);
  await framesIdle();
} else if (!nodePoint) {
  skip("selecting a node on the map (none of them is in view)");
}

// ── Pointing at a bar lights its node ──────────────────────────────────────
//
// The totals chart and the map already share a selection; hover is the glance
// between them, and it only means anything when the bars *are* nodes. Which
// dimension is on the axis is the server's call — `choose_index` lays the
// largest remaining one there — so rather than assume what summing the techs
// away leaves, the check reads the axis the chart actually drew and looks for
// the map's own feature ids on it. The assertion is feature state, the one
// thing the map is told: what MapLibre paints from it is its own business.

/** Whether a select offers `option`, so a model without it can be skipped. */
const offers = async (select, option) => {
  await testId(select).click();
  const item = page.getByRole("option", { name: option, exact: true });
  await item.first().waitFor({ timeout: 3000 }).catch(() => {});
  const found = (await item.count()) > 0;
  if (!found) await page.keyboard.press("Escape");
  return found;
};
/** Picks an option in a select that is already open, from `offers`. */
const pickOpen = (option) =>
  settle(() => page.getByRole("option", { name: option, exact: true }).click());

const variableBefore = (await testId("static-variable").innerText()).trim();
if (await offers("static-variable", "flow_cap")) await pickOpen("flow_cap");
await settle(() =>
  testId("static-sum-by").getByText("Sum techs", { exact: true }).click(),
);

/** The categories on the totals axis that are nodes on the map. */
const nodeBars = () =>
  page.evaluate(() => {
    const axis = window.__cgCharts?.static?.getOption()?.xAxis?.[0]?.data ?? [];
    const ids = new Set(
      window.__cgMap
        .getSource("nodes")
        .serialize()
        .data.features.map((feature) => String(feature.id)),
    );
    return axis.map(String).filter((name) => ids.has(name));
  });
const highlighted = (node) =>
  page.evaluate(
    (id) => window.__cgMap.getFeatureState({ source: "nodes", id }).highlight === true,
    node,
  );
/** The bar's position on the axis, and the chart action that points at it. */
const barIndex = (node) =>
  page.evaluate(
    (name) =>
      window.__cgCharts.static.getOption().xAxis[0].data.map(String).indexOf(name),
    node,
  );
const pointAt = (index) =>
  page.evaluate(
    (dataIndex) =>
      window.__cgCharts.static.dispatchAction({
        type: "updateAxisPointer",
        seriesIndex: 0,
        dataIndex,
      }),
    index,
  );

const bars = await stable(nodeBars);
if (bars.length > 0) {
  const node = bars[0];
  const index = await barIndex(node);

  // The real pointer first: the bar's pixel comes from the chart's own
  // projection, halfway up its stack, so the move lands inside the axis
  // pointer's band whatever the bars' heights are.
  const target = await page.evaluate((position) => {
    const chart = window.__cgCharts.static;
    let top = 0;
    for (const series of chart.getOption().series ?? []) {
      const point = series.data?.[position];
      const value =
        typeof point === "number" ? point : Array.isArray(point) ? point[1] : point?.value;
      top += Number(value) || 0;
    }
    const [x, y] = chart.convertToPixel({ seriesIndex: 0 }, [position, top / 2]);
    const rect = chart.getDom().getBoundingClientRect();
    return { x: rect.left + x, y: rect.top + y };
  }, index);
  await page.mouse.move(target.x, target.y);
  check("pointing at a node's bar lights that node on the map", await until(() => highlighted(node)), node);

  // Off the chart and onto the map's own canvas — its corner, where no node
  // sits — which is where a reader looking for the halo would go.
  const mapBox = await page.locator(".maplibregl-canvas").first().boundingBox();
  await page.mouse.move(mapBox.x + 8, mapBox.y + 8);
  check(
    "and leaving the chart puts it out",
    await until(async () => !(await highlighted(node))),
  );

  // The same through the chart's own action, which is what a pointer move
  // becomes inside ECharts — so a failure above with a pass here is geometry,
  // not wiring.
  await pointAt(index);
  check("the chart's own axis-pointer action lights it too", await until(() => highlighted(node)));
  await page.evaluate(() =>
    window.__cgCharts.static.dispatchAction({ type: "updateAxisPointer", currTrigger: "leave" }),
  );
  check(
    "and its leave action clears it",
    await until(async () => !(await highlighted(node))),
  );
} else {
  skip("linked hover (the totals axis is not nodes on this model)");
}
await settle(() => testId("static-sum-by").getByText("No sum", { exact: true }).click());
// The variable too, or the theme screenshots below photograph `flow_cap`.
if (variableBefore && variableBefore !== "flow_cap" && (await offers("static-variable", variableBefore))) {
  await pickOpen(variableBefore);
}

// ── Both themes ────────────────────────────────────────────────────────────
//
// The assertion is on the token itself: for most of this project's life
// `tokens.css` was never imported at all, so this returned the same value in
// both modes.
const themeValue = () =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--cg-bg").trim(),
  );
const lightBg = await themeValue();

await page.evaluate(() => localStorage.setItem("calliope-studio.theme", "dark"));
await page.reload({ waitUntil: "domcontentloaded" });
await testId("run-results").waitFor({ timeout: 30000 });
await mapReady().catch(() => false);
await framesIdle();

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

// The attribution strip, which the control check above does not reach — and so
// the one piece of chrome that stayed stock. maplibre-gl.css styles it through
// two-class selectors and beat the bare-class override in maplibre-overrides.css
// for as long as that file existed, leaving a white plate and black text on a
// dark map. Read through a canvas rather than matching the string: the
// background is a color-mix() of an oklch token, so getComputedStyle serialises
// it as `color(srgb ...)`, which both the regex above and the luminance() helper
// below would misread. `fillStyle` parses every form the browser can compute.
const attribution = await page.evaluate(() => {
  const strip = document.querySelector(".maplibregl-ctrl-attrib");
  if (!strip) return null;
  const style = getComputedStyle(strip);
  const context = document.createElement("canvas").getContext("2d");
  const bytes = (value) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  };
  return { background: bytes(style.backgroundColor), text: bytes(style.color) };
});
// `compact: true` means the control is always created, so a missing strip is
// itself a failure rather than a case to skip.
const isDark = ([red, green, blue]) => red < 128 && green < 128 && blue < 128;
check(
  "the map's attribution strip follows the theme",
  Boolean(attribution) && isDark(attribution.background) && !isDark(attribution.text),
  attribution && `plate ${attribution.background}, text ${attribution.text}`,
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

await page.screenshot({ path: "/tmp/calliope-studio-smoke-map.png", fullPage: true });
check("no console errors throughout", consoleErrors.length === 0);
await finish(browser, consoleErrors);
