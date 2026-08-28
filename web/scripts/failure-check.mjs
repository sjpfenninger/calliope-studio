/**
 * A failed write must say so — on screen, beside the thing that failed.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run failure-check http://127.0.0.1:8791
 *
 * Every other browser check exercises the success path, which leaves one class
 * of bug entirely uncovered: an error surface that exists but is not wired.
 * `CsvGridEditor` shipped exactly that — a toolbar supporting `:error` with
 * nothing bound to it — and it typechecked, linted and passed every check
 * while a failed save showed the user nothing. Whether a message *renders* is
 * only observable by making a request actually fail, so this check intercepts
 * writes at the network layer with `page.route` and serves a 500 whose
 * `detail` string it then expects to find on screen.
 *
 * Three surfaces, one per kind of write:
 *   - a structured editor's Save → `EditorToolbar`'s alert, tab stays dirty
 *   - a raw Monaco Cmd+S → the editor's own alert strip, tab stays dirty
 *   - starting a run → the run list's action-error message
 * The first two also assert recovery: lift the interception, save again, and
 * the error clears with the tab going clean — an error that outlives the
 * failure it reports is the same lesson in distrust as no error at all.
 *
 * The console is deliberately not asserted clean here: an injected 500 makes
 * Chromium log "Failed to load resource" all by itself, so a no-console-errors
 * check would fail on the injection rather than on the app.
 */
import { health, open, requireMode, results, trackRequests } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";
const payload = requireMode(await health(BASE), "workspace", BASE);
const ws = payload.workspace_id;

const { check, finish } = results("failure");
const { browser, page, testId, until } = await open();
const calls = trackRequests(page, (request) => request.url().includes("/api/"));

const DETAIL = "Injected failure — nothing was written.";
const filesUrl = (path) => `${BASE}/api/versions/${ws}/files/${path}`;
const readFile = async (path) => (await (await fetch(filesUrl(path))).json()).content;
const restore = (path, content) =>
  fetch(filesUrl(path), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });

/** Fails every request matching `pattern` with the given method, with a 500. */
const inject = (pattern, method) =>
  page.route(pattern, (route) =>
    route.request().method() === method
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: DETAIL }),
        })
      : route.fallback(),
  );

const dirtyDot = () =>
  page.locator('[data-testid^="tab-"][data-active] [data-testid="tab-dirty"]').count();
const errorText = async () =>
  (await testId("save-error").first().textContent().catch(() => "")) ?? "";

const scenariosOriginal = await readFile("scenarios.yaml");
const modelOriginal = await readFile("model.yaml");

const END = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

console.log(`Failure surfaces at ${BASE}`);

try {
  await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
  await testId("model-tree").waitFor({ timeout: 20000 });
  await calls.idle();

  // ── a structured editor's save ─────────────────────────────────────────────
  await calls.settle(() =>
    page.getByRole("treeitem", { name: /^scenarios$/i }).first().click(),
  );
  await testId("scenarios-editor").waitFor({ timeout: 15000 });
  const nameField = testId("scenario").first().locator("input").first();
  await nameField.fill(`${await nameField.inputValue()}zz`);
  await testId("tab-dirty").first().waitFor({ timeout: 5000 });

  await inject("**/yaml-section/**", "PUT");
  await calls.settle(() => testId("save").click(), { timeout: 20000 });
  const structuredShown = await until(
    async () => (await errorText()).includes(DETAIL),
    { timeout: 10000 },
  );
  check("a failed structured save shows the server's own message", structuredShown);
  check("and the tab stays dirty", (await dirtyDot()) === 1);

  await page.unroute("**/yaml-section/**");
  await calls.settle(() => testId("save").click(), { timeout: 20000 });
  const structuredCleared = await until(
    async () => (await testId("save-error").count()) === 0 && (await dirtyDot()) === 0,
    { timeout: 10000 },
  );
  check("saving again clears the error and the dot", structuredCleared);

  // ── a raw Monaco save ──────────────────────────────────────────────────────
  await page.getByRole("link", { name: "Files" }).click();
  await testId("file-tree").waitFor({ timeout: 20000 });
  await page.getByText("model.yaml", { exact: true }).first().click();
  await page.locator(".view-lines").first().locator("text=config").first().waitFor({
    timeout: 30000,
  });
  await page.locator(".view-lines").first().click();
  await page.keyboard.press(END);
  await page.keyboard.type("\n# scratch\n");
  await testId("tab-dirty").first().waitFor({ timeout: 5000 });

  await inject("**/files/**", "PUT");
  await calls.settle(() => page.keyboard.press("ControlOrMeta+s"), { timeout: 20000 });
  const rawShown = await until(async () => (await errorText()).includes(DETAIL), {
    timeout: 10000,
  });
  check("a failed raw save shows the message above the editor", rawShown);
  check("and the buffer stays dirty", (await dirtyDot()) === 1);

  await page.unroute("**/files/**");
  await calls.settle(() => page.keyboard.press("ControlOrMeta+s"), { timeout: 20000 });
  const rawCleared = await until(
    async () => (await testId("save-error").count()) === 0 && (await dirtyDot()) === 0,
    { timeout: 10000 },
  );
  check("saving again clears it", rawCleared);

  // ── starting a run ─────────────────────────────────────────────────────────
  await inject("**/runs/", "POST");
  await page.getByRole("link", { name: "Runs" }).click();
  await testId("start-run").waitFor({ timeout: 15000 });
  await calls.settle(() => testId("start-run").click(), { timeout: 20000 });
  const runShown = await until(
    async () =>
      ((await testId("run-action-error").textContent().catch(() => "")) ?? "").includes(
        DETAIL,
      ),
    { timeout: 10000 },
  );
  check("a failed run start says why in the run list", runShown);
  check(
    "and the Run button is usable again",
    await testId("start-run").isEnabled(),
  );
  await page.unroute("**/runs/");
} catch (error) {
  check("the check ran to completion", false, error.message.split("\n")[0]);
} finally {
  // The recovery saves wrote the injected edits for real; put both files back.
  await restore("scenarios.yaml", scenariosOriginal);
  await restore("model.yaml", modelOriginal);
  check(
    "teardown restored both files byte-for-byte",
    (await readFile("scenarios.yaml")) === scenariosOriginal &&
      (await readFile("model.yaml")) === modelOriginal,
  );
  await finish(browser);
}
