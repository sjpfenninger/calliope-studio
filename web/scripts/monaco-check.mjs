/**
 * The YAML editor, and the language worker behind it.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run monaco-check http://127.0.0.1:8791
 *
 * For most of this project's life that worker answered *nothing*. Every request
 * failed with `Missing requestHandler or method: doValidation / findLinks /
 * getCodeAction / findDocumentSymbols / getFoldingRanges`, so schema validation,
 * completion, symbols and folding were all dead — the entire reason monaco-yaml
 * is a dependency — and the only sign was six console errors nobody was reading.
 *
 * The cause was a version mismatch: monaco-editor 0.53 changed how a worker
 * hands over its foreign module, and monaco-yaml still speaks the older
 * protocol. `package.json` pins monaco-editor accordingly, and this is the check
 * that would notice if the pin were lifted.
 *
 * Validation is asserted through the markers Monaco puts in the DOM, because
 * that is the end of the chain: schema fetched, worker started, request
 * dispatched, answer rendered. If a squiggle appears for a key the schema
 * forbids and not for one it allows, everything in between is working.
 */
import { health, open, requireMode, results } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";

const { check, skip, finish } = results("monaco");
const payload = requireMode(await health(BASE), "workspace", BASE);
const { browser, page, testId, consoleErrors, until } = await open();

console.log(`Monaco at ${BASE}`);
await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
await page.getByRole("link", { name: "Files" }).click();
await testId("file-tree").waitFor({ timeout: 20000 });
await page.getByText("model.yaml", { exact: true }).first().click();

// The editor, then its content: Monaco mounts before the file has been fetched
// into it, so waiting on `.monaco-editor` alone is waiting for the wrong thing.
await page.locator(".monaco-editor").first().waitFor({ timeout: 30000 });
await page
  .locator(".view-lines")
  .first()
  .locator("text=config")
  .first()
  .waitFor({ timeout: 30000 });

check("the editor mounts", (await page.locator(".monaco-editor").count()) > 0);
check(
  "the file's content is shown",
  (await page.locator(".view-lines").first().textContent())?.includes("config") ?? false,
);

const workerErrors = consoleErrors.filter((line) =>
  line.includes("Missing requestHandler"),
);
check(
  `the language worker answers (${workerErrors.length} handler errors)`,
  workerErrors.length === 0,
  workerErrors[0],
);

// Nothing in `model.yaml` should be wrong, so a squiggle here means the schema
// and the file disagree — which is what a broken schema graft looks like.
//
// The wait below is what makes this assertion mean anything: a document that has
// not been validated *yet* has no squiggles either, so asserting on it too early
// passes for the wrong reason — and would go on passing with the worker dead.
// So the clean case is checked only after the broken one has proved the worker
// is answering, and the file is put back in between.
const squiggles = () => page.locator(".squiggly-error, .squiggly-warning").count();

/**
 * Monaco's own bindings, which are not the same on every platform.
 *
 * The undo below used to be `Control+Z` unconditionally, and on macOS that is
 * not undo — Monaco binds `Cmd+Z`. Nothing asserted the edit had been taken
 * back, so it never came up: the check simply left a dirty editor behind, which
 * is exactly the state the *next* check's "opening does not mark the tab dirty"
 * is about.
 */
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const END = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

// Something that genuinely is wrong, first. `techs` is a mapping of tech name to
// definition, so a string there is a type error the schema can see.
await page.locator(".view-lines").first().click();
await page.keyboard.press(END);
await page.keyboard.type("\ntechs: not-a-mapping\n");
const marked = await until(async () => (await squiggles()) > 0, { timeout: 30000 });
check("a schema violation is marked", marked);

await page.screenshot({ path: "/tmp/calliope-studio-monaco.png" });
console.log("screenshot: /tmp/calliope-studio-monaco.png");

// Undo, so the file is left as it was found. The editor never saved it, but a
// dirty tab would make the next check's "opening does not mark the tab dirty"
// assertion fail for reasons that have nothing to do with it.
//
// Until the markers clear, rather than a fixed number of presses. Two things
// make a count wrong: Monaco decides for itself how to group an edit into undo
// steps, and monaco-yaml re-validates on a change rather than on a timer, so the
// squiggle outlives the text by one edit. Undoing to a condition covers both.
//
// This *is* the clean-file assertion, which is why it comes after the broken one
// rather than before. On a freshly opened file "no squiggles" is also what a
// document that has not been validated yet looks like, so asserting it up front
// passed for the wrong reason and would have gone on passing with the worker
// dead. Undo cannot go back past the file as it was loaded, so a model that
// genuinely did not validate would never reach zero.
const typed = () =>
  page
    .locator(".view-lines")
    .first()
    .textContent()
    .then((text) => text?.includes("not-a-mapping") ?? false);

const cleared = await until(
  async () => {
    if ((await squiggles()) === 0) return true;
    await page.keyboard.press(`${MOD}+Z`);
    return false;
  },
  { timeout: 20000, interval: 200 },
);
check("a valid model validates clean, once the edit is taken back", cleared);
check("and the edit really is gone", !(await typed()));

// Which schema a file is checked against.
//
// One association matching `*.yaml` is all a single `fileMatch` can say, and it
// meant every file was checked against the model-definition schema — so a math
// file, which shares none of its keys, reported all of them as unknown. The kind
// is detected from how Calliope *reaches* the file, and is correctable, because
// a file drafted before it is imported is reachable from nothing.
const kindLabel = async () => (await testId("schema-kind-trigger").textContent()).trim();

await testId("schema-kind").waitFor({ timeout: 20000 });
check(
  "the entry point is checked against the model definition",
  /Model definition/i.test(await kindLabel()),
  await kindLabel(),
);

// `urban_scale` names its math in `config.init.math_paths`, which the import
// graph cannot see; `national_scale` has no math file, so it is skipped rather
// than asserted on the wrong model.
const mathFile = page.getByText("additional_math.yaml", { exact: true }).first();
if (await mathFile.count()) {
  await mathFile.click();
  const isMath = await until(async () => /Math/i.test(await kindLabel()), {
    timeout: 20000,
  });
  check("a math file is checked against the math schema", isMath, await kindLabel());

  await testId("schema-kind-trigger").click();
  await page.getByRole("option", { name: "Model definition" }).click();
  const overridden = await until(
    async () => /Model definition/i.test(await kindLabel()),
    { timeout: 20000 },
  );
  check("the user can correct a kind we got wrong", overridden);
  check("and it is marked as theirs", (await testId("schema-kind-reset").count()) === 1);

  await testId("schema-kind-reset").click();
  const reset = await until(async () => /Math/i.test(await kindLabel()), {
    timeout: 20000,
  });
  check("resetting hands it back to detection", reset);
} else {
  // `national_scale` has no math file. Run this against `urban_scale` for the
  // case the whole classifier exists for.
  skip("a math file is checked against the math schema — no math file here");
}

// ── buffer coherence ─────────────────────────────────────────────────────────
//
// The raw buffer of a file is what Cmd+S writes back, so it has to follow the
// file: a structured save lands on disk and an open, clean raw buffer must pick
// it up, or the next raw save reverts it. And a closed tab's buffer is gone —
// reopening the file must show the disk, not resurrect discarded edits as if
// they were saved.
const filesUrl = (path) => `${BASE}/api/versions/${payload.workspace_id}/files/${path}`;
const readFile = async (path) => (await (await fetch(filesUrl(path))).json()).content;
const scenariosOriginal = await readFile("scenarios.yaml");

const buffer = async () =>
  (await page.locator(".view-lines").first().textContent()) ?? "";

try {
  // A raw tab for the file, promoted out of the preview slot: a preview is
  // evicted by the next tree click, and an evicted tab's buffer is disposed —
  // which would pass the refresh check without exercising the refresh.
  await page.getByRole("link", { name: "Files" }).click();
  await testId("file-tree").waitFor({ timeout: 20000 });
  await page.getByText("scenarios.yaml", { exact: true }).first().click();
  const scenariosTab = page
    .locator('[data-testid="tab-file"]', { hasText: "scenarios.yaml" })
    .first();
  await scenariosTab.dblclick();
  await until(async () => (await buffer()).includes("cold_fusion"), { timeout: 20000 });

  // Rename a scenario in the structured editor and save. `fill` rather than
  // keystrokes: the entry list re-renders on the first name change, and a
  // remounted input drops the keystrokes still in flight.
  await page.getByRole("link", { name: "Model" }).click();
  await page.getByRole("treeitem", { name: /^scenarios$/i }).first().click();
  await testId("scenarios-editor").waitFor({ timeout: 15000 });
  const nameField = testId("scenario").first().locator("input").first();
  const renamed = `${await nameField.inputValue()}zz`;
  await nameField.fill(renamed);
  await testId("save").click();
  await until(async () => (await readFile("scenarios.yaml")).includes(renamed), {
    timeout: 20000,
  });

  await scenariosTab.click();
  const refreshed = await until(async () => (await buffer()).includes(renamed), {
    timeout: 20000,
  });
  check("a structured save reaches an open raw buffer", refreshed);

  // Cmd+S with focus *outside* the editor. The shortcut used to be Monaco's
  // own command, which answers only while the editor has focus: click the tab
  // strip, press Cmd+S, and the browser's Save dialog opened over a dirty
  // file. The listener is on `window` now, gated on the tab in front.
  await page.locator(".view-lines").first().click();
  await page.keyboard.press(END);
  await page.keyboard.type("\n# scratch\n");
  await testId("tab-dirty").first().waitFor({ timeout: 5000 });
  await scenariosTab.click();
  check(
    "focus has left the editor",
    !(await page.evaluate(() => Boolean(document.activeElement?.closest(".monaco-editor")))),
  );
  await page.keyboard.press(`${MOD}+s`);
  const savedFromStrip = await until(
    async () => (await readFile("scenarios.yaml")).includes("# scratch"),
    { timeout: 20000 },
  );
  check("Cmd+S saves the raw buffer with focus outside the editor", savedFromStrip);
  const cleanAfterSave = await until(
    async () =>
      (await page
        .locator('[data-testid^="tab-"][data-active] [data-testid="tab-dirty"]')
        .count()) === 0,
    { timeout: 5000 },
  );
  check("and the tab goes clean", cleanAfterSave);

  // Dirty the raw buffer, close its tab past the guard, reopen from the tree.
  await page.locator(".view-lines").first().click();
  await page.keyboard.press(END);
  await page.keyboard.type("\n# discarded\n");
  await testId("tab-dirty").first().waitFor({ timeout: 5000 });
  await scenariosTab.hover();
  await scenariosTab.getByRole("button", { name: "Close tab" }).click();
  await testId("confirm-dialog").waitFor({ timeout: 8000 });
  await testId("confirm-accept").click();

  await page.getByRole("link", { name: "Files" }).click();
  await testId("file-tree").waitFor({ timeout: 20000 });
  await page.getByText("scenarios.yaml", { exact: true }).first().click();
  await until(async () => (await buffer()).includes("cold_fusion"), { timeout: 20000 });
  check(
    "a reopened file shows the disk, not the closed tab's edits",
    !(await buffer()).includes("discarded"),
  );
  check(
    "and opens clean",
    (await page
      .locator('[data-testid^="tab-"][data-active] [data-testid="tab-dirty"]')
      .count()) === 0,
  );
} finally {
  // The CI server is shared with the checks that follow, and save-check reads
  // this very file.
  await fetch(filesUrl("scenarios.yaml"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: scenariosOriginal }),
  });
}

await finish(browser);
