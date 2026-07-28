/**
 * The run loop, end to end, against a running server on a real model.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
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
import { health, open, quiet, requireMode, results, until } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";

const { check, finish } = results("run-lifecycle");
const payload = requireMode(await health(BASE), "workspace", BASE);
const { browser, page, testId, consoleErrors, frames, framesIdle, mapReady } =
  await open();

console.log(`Run lifecycle at ${BASE}`);

/** Every run request as it went out, so the picker can be checked at the wire. */
const starts = [];
page.on("request", (request) => {
  const path = new URL(request.url()).pathname;
  if (request.method() !== "POST" || !path.endsWith("/runs/")) return;
  try {
    starts.push(JSON.parse(request.postData() ?? "{}"));
  } catch {
    /* not our payload */
  }
});

await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
await page.getByRole("link", { name: "Runs" }).click();
await testId("start-run").waitFor();

await testId("start-run").click();
await testId("run-log").waitFor({ timeout: 30000 });
// The tab is open, so the POST has been answered and its body is captured.
check("the model as written asks for no scenario", starts.at(-1)?.scenario === null);
check("the run's tab opens immediately, on the log", page.url().includes("tab=run"));

// Sampled twice rather than counted once: a fixed wait and a `> 1` count would
// pass on the two lines a run emits before the solver starts, which is exactly
// what it did while all of the solver's own output was being dropped on the wire.
const lines = () => page.locator('[data-testid="run-log"] p').count();
// Bounded rather than timed: what matters is that lines arrive at all, and the
// second sample below is what shows they keep arriving.
await until(async () => (await lines()) > 1, { timeout: 60000, interval: 100 });
const early = await lines();
check("log lines arrive as soon as the run starts", early > 1);

// The stages Calliope reports passing, sampled as the run goes: they are gone
// from the display the moment the next one starts.
const seenStages = new Set();
await until(
  async () => {
    const progress = testId("run-progress");
    if (await progress.count()) {
      const stage = await progress.first().getAttribute("data-stage");
      if (stage) seenStages.add(stage);
    }
    return seenStages.has("solve");
  },
  // A quarter-second: a stage is gone from the display the moment the next one
  // starts, so a coarse poll can miss one entirely on a fast model.
  { timeout: 120000, interval: 250 },
);
check("progress reports the backend build", seenStages.has("build"));
check("progress reports the solve", seenStages.has("solve"));

await until(async () => (await lines()) > early, { timeout: 120000, interval: 100 });
const later = await lines();
check(
  "the log keeps growing while the solver runs",
  later > early,
  `${early} lines early, ${later} later`,
);
// The tab moves itself to the charts when the results handle arrives.
await testId("run-results").waitFor({ timeout: 300000 });
await page.locator("canvas").first().waitFor({ timeout: 60000 });
await until(() => frames.length >= 2, { timeout: 60000 });
await mapReady().catch(() => false);
await framesIdle();

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
await testId("run-log").waitFor({ timeout: 30000 });

// Asserted here rather than mid-solve: Pyomo buffers a subprocess solver's
// output and hands Calliope the lot at the end, so CBC's arrives in two chunks
// when it exits. The point is that it arrives at all — it used to reach nothing
// but `run.log`, and all but the first line of each chunk was dropped by the
// wire format on the way here.
check(
  "the solver's own output reaches the log, not only run.log",
  (await page.locator('[data-testid="run-log"] p[data-level="DEBUG"]').count()) > 2,
);

const shown = () => page.locator('[data-testid="run-log"] p[data-level]').count();
const everything = await shown();
await testId("log-filter").selectOption("errors");
await until(async () => (await shown()) < everything, { timeout: 15000, interval: 50 });
const onlyErrors = await shown();
await testId("log-filter").selectOption("all");
await until(async () => (await shown()) === everything, { timeout: 15000, interval: 50 });
check(
  "the log filter narrows the view and gives it back",
  onlyErrors < everything && (await shown()) === everything,
  `${everything} lines, ${onlyErrors} at errors-only`,
);

await testId("run-subtab-results").click();
// Nothing to wait for — the assertion is that no request goes out.
await quiet(500);
check("returning to the charts issues no new frame request", frames.length === settled);

// The frozen configuration, which only exists because the run was snapshotted
// before the worker started.
await testId("run-subtab-config").click();
await testId("snapshot-tree").waitFor({ timeout: 10000 });
await testId("snapshot-tree").getByText("model.yaml").first().waitFor({ timeout: 20000 }).catch(() => {});
check(
  "the frozen tree lists the model",
  (await testId("snapshot-tree").getByText("model.yaml").count()) > 0,
);
check(
  "the frozen file's content is shown",
  ((await testId("snapshot-content").textContent()) ?? "").includes("import"),
);

await testId("config-view-solved").click();
await testId("run-summary").waitFor({ timeout: 30000 });
await until(async () => (await testId("run-summary").locator("dt").count()) > 5, {
  timeout: 30000,
});
check(
  "the as-solved summary renders",
  (await testId("run-summary").locator("dt").count()) > 5,
);

// --- and again, with a scenario picked --------------------------------------
//
// A second run rather than a scenario on the first: `time_resampling` subsets to
// one month at 6h, and using it above would silence the two checks that need a
// solve long enough to watch — the log growing, and the solve stage being seen.
//
// Every run tab stays mounted (`TabBody` uses `v-show`, deliberately), so from
// here a bare test id matches both tabs' copies. `:visible` is the one in front.
const PICK = "time_resampling";
const visible = (name) => page.locator(`[data-testid="${name}"]:visible`);

await page.getByRole("link", { name: "Runs" }).click();
await testId("scenario-strip").waitFor({ timeout: 10000 });
await testId("run-scenario").click();
await page.getByRole("option", { name: PICK, exact: true }).click();
check(
  "the picker shows what was chosen",
  ((await testId("run-scenario").textContent()) ?? "").includes(PICK),
);

const startsBefore = starts.length;
const runRows = () => page.locator('[data-testid="run-list"] > *').count();
const rowsBefore = await runRows();
await testId("start-run").click();
await until(() => starts.length > startsBefore, { timeout: 30000 });
check(
  "the picked scenario reaches the request",
  starts.at(-1)?.scenario === PICK,
  JSON.stringify(starts.at(-1)),
);

// The list has to have gained the new run before "the newest" means it — the
// previous one is already sitting at the top, and already `success`, so polling
// its status returns the moment it is asked and every assertion below is about
// the wrong run. The old 2-second sleep here was covering exactly this.
await until(async () => (await runRows()) > rowsBefore, { timeout: 30000 });

const newest = page
  .locator('[data-testid="run-list"] [data-testid="run-status"]')
  .first();
let outcome = null;
await until(
  async () => {
    outcome = await newest.getAttribute("data-status");
    return ["success", "infeasible", "failed", "cancelled"].includes(outcome);
  },
  { timeout: 300000, interval: 250 },
);
check("the scenario run finishes", outcome === "success", `status ${outcome}`);
check(
  "the history says which scenario the run used",
  (
    (await page.locator('[data-testid="run-list"] > *').first().textContent()) ?? ""
  ).includes(PICK),
);

// The one assertion an echoed payload cannot fake: Calliope itself reporting,
// out of the solved file, which overrides it applied.
await visible("run-subtab-config").click();
await visible("config-view-solved").waitFor({ timeout: 10000 });
await visible("config-view-solved").click();
await visible("run-summary").waitFor({ timeout: 30000 });
await until(
  async () => ((await visible("run-summary").textContent()) ?? "").includes(PICK),
  { timeout: 30000 },
);
check(
  "Calliope reports the override as applied",
  ((await visible("run-summary").textContent()) ?? "").includes(PICK),
);

await page.screenshot({ path: "/tmp/calliope-studio-run-lifecycle.png", fullPage: true });
console.log("screenshot: /tmp/calliope-studio-run-lifecycle.png");

await finish(browser, consoleErrors);
