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

// Deselecting a technology must remove its series, which merging never does.
await testId("plot-type").getByText("Bar", { exact: true }).click();
await page.waitForTimeout(1500);
const beforeDeselect = frames.length;
const techRows = page.locator('[data-testid^="filter-techs-"]');
if (await techRows.count()) {
  await techRows.first().click();
} else {
  // A model with more technologies than fit as checkboxes gets the searchable
  // control instead.
  await testId("filter-techs").getByRole("combobox").click();
  await page.getByRole("option").first().click();
  await page.keyboard.press("Escape");
}
await page.waitForTimeout(2500);
check("deselecting a technology re-queries", frames.length > beforeDeselect);

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
await page.evaluate(() => localStorage.setItem("calliope-studio.theme", "dark"));
await page.reload({ waitUntil: "networkidle" });
await testId("run-results").waitFor({ timeout: 20000 });
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

await page.screenshot({ path: "/tmp/calliope-studio-smoke.png", fullPage: true });
console.log("screenshot: /tmp/calliope-studio-smoke.png");

await finish(browser, consoleErrors);
