/**
 * One buffer per file: the rule that ends lost updates between two editors.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run same-file-lock http://127.0.0.1:8791
 *
 * Every lost update this app has produced involved two buffers on one file —
 * Techs and Links on one `techs:` section, a section tab and the raw file tab
 * of the same file — where the second to save merged against a baseline the
 * first had already replaced and silently reverted it. The rule in
 * `stores/tabs.ts::dirtyOwner` refuses the second buffer instead: it is shown
 * read-only with a banner naming the tab that holds the edits, and two ways
 * out — go there, or discard those edits.
 *
 * Only a browser can check the half that matters: that the second pane is
 * *actually* disabled, that the banner's buttons land where they say, and that
 * a discard puts every buffer on the file back to what is on disk. The
 * example model's `scenarios.yaml` carries both `overrides:` and `scenarios:`,
 * so two section tabs share a file without any setup.
 *
 * Two more things ride along because they need the same dirty buffer:
 * `beforeunload` is armed only while something is unsaved, and a CSV tab keeps
 * its cell edits across a look at another tab — the grid used to be remounted,
 * reloading the file under a dirty dot that then lied.
 */
import { health, open, quiet, requireMode, results, trackRequests, until } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";
const payload = requireMode(await health(BASE), "workspace", BASE);

const { check, finish } = results("same-file-lock");
const { browser, page, testId, consoleErrors } = await open();
const calls = trackRequests(page, (request) => request.url().includes("/api/"));

const sectionTab = (name) =>
  page.locator('[data-testid="tab-section"]', { hasText: name }).first();
const activeTab = () => page.locator('[data-testid^="tab-"][data-active]').first();
const dirtyDots = () => page.locator('[data-testid="tab-dirty"]').count();

/** Whether the browser would ask before unloading right now. */
const unloadGuarded = () =>
  page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

const openSection = async (name) => {
  await page.getByRole("link", { name: "Model" }).click();
  await calls.settle(() =>
    page.getByRole("treeitem", { name: new RegExp(`^${name}$`, "i") }).first().click(),
  );
  // Promoted out of the preview slot, or the next tree click evicts it.
  await sectionTab(name).dblclick();
};

const scenarioName = () => testId("scenario").first().locator("input").first();

console.log(`One buffer per file at ${BASE}`);

try {
  await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
  await testId("model-tree").waitFor({ timeout: 20000 });
  await calls.idle();
  check("a clean model does not arm beforeunload", !(await unloadGuarded()));

  // ── two section tabs on one file ────────────────────────────────────────────
  await openSection("scenarios");
  await testId("scenarios-editor").waitFor({ timeout: 15000 });
  const original = await scenarioName().inputValue();
  await scenarioName().click();
  await scenarioName().press("End");
  await scenarioName().press("x");
  await testId("tab-dirty").first().waitFor({ timeout: 5000 });
  check("typing in the scenarios form dirties its tab", true);
  check("an unsaved buffer arms beforeunload", await unloadGuarded());

  await openSection("overrides");
  await testId("overrides-editor").waitFor({ timeout: 15000 });
  const banner = testId("locked-banner");
  await banner.waitFor({ timeout: 8000 });
  check("the overrides tab on the same file shows the lock banner", true);
  check(
    "and names the tab holding the edits",
    (await banner.innerText()).includes("scenarios"),
  );
  check(
    "and its fields are disabled",
    await testId("overrides-editor").locator("input").first().isDisabled(),
  );
  check(
    "and its Save button is disabled",
    await testId("overrides-editor").getByTestId("save").isDisabled(),
  );

  await testId("locked-go").click();
  await until(async () => (await activeTab().innerText()).includes("scenarios"), {
    timeout: 5000,
  });
  check("Go there fronts the tab with the edits", true);
  check("and those edits are still there", (await scenarioName().inputValue()) === `${original}x`);

  await sectionTab("overrides").click();
  await banner.waitFor({ timeout: 5000 });
  await testId("locked-discard").click();
  await testId("confirm-dialog").waitFor({ timeout: 8000 });
  await testId("confirm-accept").click();
  await banner.waitFor({ state: "hidden", timeout: 8000 });
  check("Discard removes the banner", true);
  await until(async () => (await dirtyDots()) === 0, { timeout: 5000 });
  check("and clears the other tab's dirty dot", true);
  check(
    "and the overrides form takes edits again",
    !(await testId("overrides-editor").locator("input").first().isDisabled()),
  );

  await sectionTab("scenarios").click();
  await until(async () => (await scenarioName().inputValue()) === original, { timeout: 8000 });
  check("and the discarded form shows the disk again", true);
  check("a discarded buffer disarms beforeunload", !(await unloadGuarded()));

  // ── a raw file tab against a section tab of the same file ───────────────────
  await page.getByRole("link", { name: "Files" }).click();
  await testId("file-tree").waitFor({ timeout: 20000 });
  await page.getByText("scenarios.yaml", { exact: true }).first().click();
  const fileTab = page
    .locator('[data-testid="tab-file"]', { hasText: "scenarios.yaml" })
    .first();
  await fileTab.dblclick();
  const lines = page.locator(".view-lines").first();
  await until(async () => ((await lines.textContent()) ?? "").includes("overrides"), {
    timeout: 20000,
  });
  await lines.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  await page.keyboard.type("\n# scratch\n");
  await testId("tab-dirty").first().waitFor({ timeout: 5000 });

  await sectionTab("scenarios").click();
  await banner.waitFor({ timeout: 8000 });
  check("a dirty raw buffer locks the section form of the same file", true);
  check(
    "and the banner names the file tab",
    (await banner.innerText()).includes("scenarios.yaml"),
  );

  await testId("locked-discard").click();
  await testId("confirm-dialog").waitFor({ timeout: 8000 });
  await testId("confirm-accept").click();
  await banner.waitFor({ state: "hidden", timeout: 8000 });
  await fileTab.click();
  await until(async () => !((await lines.textContent()) ?? "").includes("scratch"), {
    timeout: 8000,
  });
  check("discarding reloads the raw buffer from disk", true);

  // ── a CSV tab keeps its cells across a look elsewhere ──────────────────────
  await page.getByRole("link", { name: "Files" }).click();
  await testId("file-tree").waitFor({ timeout: 20000 });
  await page.getByRole("treeitem", { name: /^data_tables$/ }).first().click();
  await page.getByText("costs.csv", { exact: true }).first().click();
  const csvTab = page.locator('[data-testid="tab-file"]', { hasText: "costs.csv" }).first();
  await csvTab.dblclick();
  const cell = page.locator(
    '[data-testid="csv-grid"] .ag-row[row-index="0"] .ag-cell[col-id="c1"]',
  );
  await cell.waitFor({ timeout: 15000 });
  await cell.click();
  await page.keyboard.type("4242");
  await page.keyboard.press("Enter");
  await testId("tab-dirty").first().waitFor({ timeout: 5000 });

  await sectionTab("scenarios").click();
  await quiet(200);
  await csvTab.click();
  await until(async () => ((await cell.textContent()) ?? "").includes("4242"), {
    timeout: 8000,
  });
  check("a CSV tab keeps its cell edits across a look at another tab", true);
  check("and its dirty dot", (await dirtyDots()) === 1);

  // Leave nothing behind: the close guard discards the cell edit.
  await csvTab.hover();
  await csvTab.getByRole("button", { name: "Close tab" }).click();
  await testId("confirm-dialog").waitFor({ timeout: 8000 });
  await testId("confirm-accept").click();
  await until(async () => (await dirtyDots()) === 0, { timeout: 5000 });
} catch (error) {
  check("the check ran to completion", false, error.message.split("\n")[0]);
} finally {
  await finish(browser, consoleErrors);
}
