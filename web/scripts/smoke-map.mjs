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
const { check, finish } = results("map");
const { browser, page, testId, consoleErrors, frames, settle, framesIdle, mapReady } =
  await openResults(BASE);

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
