/**
 * A browser smoke test against a running server.
 *
 *   pixi run calligraph --no-browser --port 8790 path/to/results.nc
 *   npm run smoke -- http://127.0.0.1:8790
 *
 * Type-checking and unit tests cannot see the things that actually broke here:
 * an Arrow reader whose schema is only on the batch, an ECharts option merge
 * that never removes a series, a map layer that silently draws nothing. Each of
 * those looked fine until a real browser rendered it.
 *
 * Every selector is a `data-testid`. The previous version drove the results view
 * through `.p-selectbutton` and `.p-checkbox`, and every one of them died the
 * moment those controls stopped being PrimeVue — selecting on a framework's
 * class names is a large part of what made that migration expensive, and there
 * is no reason to re-earn it.
 *
 * Uses the system Chromium rather than downloading one, so it needs
 * `playwright-core` only. Point CHROMIUM at a different binary if needed.
 */
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";
const EXECUTABLE =
  process.env.CHROMIUM ?? "/Applications/Chromium.app/Contents/MacOS/Chromium";

const failures = [];
function check(description, condition) {
  if (condition) console.log(`  ok    ${description}`);
  else {
    console.log(`  FAIL  ${description}`);
    failures.push(description);
  }
}

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

const queries = [];
page.on("request", (request) => {
  if (request.url().includes("/frame/") && request.method() === "POST") {
    try {
      queries.push(JSON.parse(request.postData() ?? "{}"));
    } catch {
      /* not our payload */
    }
  }
});

const testId = (name) => page.locator(`[data-testid="${name}"]`);

console.log(`Run view at ${BASE}`);
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
  queries.some((query) => query.order === "duration"),
);

// Deselecting a technology must remove its series, which merging never does.
await testId("plot-type").getByText("Bar", { exact: true }).click();
await page.waitForTimeout(1500);
const beforeDeselect = queries.length;
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
check("deselecting a technology re-queries", queries.length > beforeDeselect);

// The sub-views of a run tab. Results has to survive a trip to the log, or
// coming back would rebuild the map and refetch every frame.
//
// A bare `.nc` has no run behind it, so it has no log and nothing was frozen —
// both sub-views are disabled and there is nothing here to drive. Point this
// script at a workspace that has been run to exercise them.
if (await testId("run-subtab-log").isEnabled()) {
  await testId("run-subtab-log").click();
  await page.waitForTimeout(500);
  check("log sub-view opens", (await testId("run-log").count()) === 1);

  const beforeReturn = queries.length;
  await testId("run-subtab-results").click();
  await page.waitForTimeout(1500);
  check(
    "returning to results issues no new frame request",
    queries.length === beforeReturn,
  );
  check("results pane was kept alive", (await page.locator("canvas").count()) >= 2);
} else {
  console.log("  skip  run sub-views (these results have no run behind them)");
}

// Both themes. The assertion is on the token itself: for most of this project's
// life `tokens.css` was never imported at all, so this returned the same value
// in both modes.
const themeValue = () =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--cg-bg").trim(),
  );
const lightBg = await themeValue();
await page.evaluate(() => {
  localStorage.setItem("calligraph.theme", "dark");
});
await page.reload({ waitUntil: "networkidle" });
await testId("run-results").waitFor({ timeout: 20000 });
const darkBg = await themeValue();
check("the theme token actually changes", Boolean(lightBg) && lightBg !== darkBg);
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

await page.screenshot({ path: "/tmp/calligraph-smoke.png", fullPage: true });
console.log("screenshot: /tmp/calligraph-smoke.png");

if (consoleErrors.length) {
  console.log("console errors:");
  consoleErrors.slice(0, 10).forEach((line) => console.log(`  ${line}`));
}

await browser.close();
process.exit(failures.length ? 1 : 0);
