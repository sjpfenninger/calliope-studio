/**
 * The run loop, end to end, against a running server on a real model.
 *
 *   pixi run calligraph --no-browser --port 8791 example-model
 *   npm run run-lifecycle -- http://127.0.0.1:8791
 *
 * Click Run → the tab opens immediately on the log → lines stream → the run
 * finishes → the same tab shows the charts, with no reload and no navigation.
 * That loop did not exist before this branch, and it is not something
 * type-checking or a unit test can see: it spans a subprocess, an SSE stream, a
 * status poll and an Arrow fetch.
 *
 * It found two real backend bugs on its first run. A `results.nc` half-written
 * by a failing `to_netcdf` was left behind, so the run reported results it could
 * not produce; and a handle was minted the moment the file appeared, so the tab
 * opened charts while the worker still had the file open and `read_netcdf`
 * failed on it.
 *
 * Solves for real, so it takes as long as the model does.
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

const health = await (await fetch(`${BASE}/api/health`)).json();
if (health.mode !== "workspace") {
  console.error(
    `This check needs a server opened on a model folder; got mode "${health.mode}".`,
  );
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

const frames = [];
page.on("request", (request) => {
  if (request.url().includes("/frame/") && request.method() === "POST") {
    frames.push(request.url());
  }
});

const testId = (name) => page.locator(`[data-testid="${name}"]`);

console.log(`Run lifecycle at ${BASE}`);
await page.goto(`${BASE}${health.landing}`, { waitUntil: "networkidle" });
await page.getByRole("link", { name: "Runs" }).click();
await testId("start-run").waitFor();

await testId("start-run").click();
await testId("run-log").waitFor({ timeout: 30000 });
check("the run's tab opens immediately, on the log", page.url().includes("tab=run"));

await page.waitForTimeout(3000);
check(
  "log lines stream while it solves",
  (await page.locator('[data-testid="run-log"] p').count()) > 1,
);

// The tab moves itself to the charts when the results handle arrives.
await testId("run-results").waitFor({ timeout: 300000 });
await page.waitForTimeout(5000);

check("charts and map rendered", (await page.locator("canvas").count()) >= 2);
check("frames were fetched", frames.length >= 2);
check(
  "the run reports success",
  (await testId("run-status").first().getAttribute("data-status")) === "success",
);
check("no console errors through the whole loop", consoleErrors.length === 0);

// Going to the log and back must not rebuild the panes.
const settled = frames.length;
await testId("run-subtab-log").click();
await page.waitForTimeout(500);
await testId("run-subtab-results").click();
await page.waitForTimeout(2000);
check("returning to the charts issues no new frame request", frames.length === settled);

await page.screenshot({ path: "/tmp/calligraph-run-lifecycle.png", fullPage: true });
console.log("screenshot: /tmp/calligraph-run-lifecycle.png");

if (consoleErrors.length) {
  console.log("console errors:");
  consoleErrors.slice(0, 10).forEach((line) => console.log(`  ${line}`));
}

await browser.close();
process.exit(failures.length ? 1 : 0);
