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

console.log(`Results view at ${BASE}`);
await page.goto(`${BASE}/results`, { waitUntil: "networkidle" });
await page.waitForTimeout(6000);

check("charts and map rendered", (await page.locator("canvas").count()) >= 2);
check("map mounted", (await page.locator(".maplibregl-map").count()) === 1);
check("no console errors on load", consoleErrors.length === 0);

// Switching to Duration changes the axis from time to category, which an
// ECharts option merge cannot absorb.
await page.locator('.p-selectbutton >> text="Duration"').first().click();
await page.waitForTimeout(2500);
check("duration order requested", queries.some((q) => q.order === "duration"));

// Deselecting a technology must remove its series, which merging never does.
await page.locator('.p-selectbutton >> text="Bar"').first().click();
await page.waitForTimeout(1500);
const before = queries.length;
await page
  .locator(".filters .check", { hasText: "ccgt" })
  .locator("input, .p-checkbox")
  .first()
  .click();
await page.waitForTimeout(2500);
check("deselecting a technology re-queries", queries.length > before);

await page.screenshot({ path: "/tmp/calligraph-smoke.png", fullPage: true });
console.log("screenshot: /tmp/calligraph-smoke.png");

if (consoleErrors.length) {
  console.log("console errors:");
  consoleErrors.slice(0, 10).forEach((line) => console.log(`  ${line}`));
}

await browser.close();
process.exit(failures.length ? 1 : 0);
