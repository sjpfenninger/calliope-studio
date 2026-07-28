/**
 * The model picker: entries that are not clipped, and the two ways to get a model.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run model-picker http://127.0.0.1:8791
 *
 * The first half is geometry, which is why this is a browser check and not a
 * vitest. Every entry in the picker is two lines — a folder name over its path,
 * because two models called `model` in different places are otherwise
 * indistinguishable — and both places that draw one had it inside a *one-line*
 * box: the dropdown item is a fixed 24px row in the shadcn primitive, and the
 * recents row was pinned at 32px, which is exactly the height of the two lines
 * with nothing left over. Nothing throws when text overflows its box. It just
 * sits on the line below it, and only a rendered page can tell you.
 *
 * The second half is the flow that did not exist: browse to a folder with no
 * model in it, create one from a Calliope template, and land in the shell with
 * it open. It creates a real model in a scratch folder under the home directory
 * — the folder browser starts there, so it is one click away — and removes both
 * the folder and its recents entry in a `finally`.
 */
import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { api, health, open, requireMode, results } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";

/** Where the created model goes. Visible, because the browser hides dotfiles. */
const SCRATCH_NAME = "calliope-studio-check";
const SCRATCH = join(homedir(), SCRATCH_NAME);
const MODEL_NAME = "picker-check-model";

const { check, finish } = results();

const payload = requireMode(await health(BASE), "workspace", BASE);

// Refuse to touch a folder of that name that is not ours: the cleanup below
// deletes it, and it must only ever delete what this script made.
if (await stat(SCRATCH).catch(() => null)) {
  console.error(`${SCRATCH} already exists; remove it and run this again.`);
  process.exit(2);
}

const { browser, page, testId, consoleErrors } = await open();

/**
 * Whether an element's content fits inside it.
 *
 * `scrollHeight > clientHeight` is what a clipped two-line entry looks like from
 * the DOM: the box keeps its height and the text goes over the edge. A one-pixel
 * tolerance, because a fractional line-height rounds the two apart.
 */
async function fits(locator) {
  const overflowing = await locator.evaluateAll((elements) =>
    elements
      .map((element) => element.scrollHeight - element.clientHeight)
      .filter((difference) => difference > 1),
  );
  return { ok: overflowing.length === 0, overflowing };
}

await mkdir(SCRATCH);

try {
  console.log(`Checking the model picker at ${BASE}`);

  // ---------------------------------------------------------------------------
  // The recents page: rows tall enough for the two lines they hold.
  // ---------------------------------------------------------------------------

  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
  await testId("recent-models").waitFor({ timeout: 20000 });

  const rows = testId("recent-model");
  const rowCount = await rows.count();
  check("the recents page lists at least one model", rowCount > 0, `${rowCount} rows`);

  const rowFit = await fits(rows);
  check("no recents row clips its own text", rowFit.ok, JSON.stringify(rowFit.overflowing));

  const rowBox = await rows.first().boundingBox();
  check(
    "a recents row is taller than the two lines it holds",
    rowBox.height >= 36,
    `${rowBox.height}px`,
  );

  check("the recents page offers both ways to get a model", (await testId("open-model").count()) === 1 && (await testId("new-model").count()) === 1);

  // ---------------------------------------------------------------------------
  // The sidebar picker: the same entries, in the dropdown.
  // ---------------------------------------------------------------------------

  await page.goto(`${BASE}${payload.landing}`, { waitUntil: "networkidle" });
  await testId("project-switcher").waitFor({ timeout: 20000 });

  check(
    "the picker has Open and New beside it",
    (await testId("open-model").count()) === 1 && (await testId("new-model").count()) === 1,
  );

  await testId("project-switcher").click();
  await testId("switcher-model").first().waitFor({ timeout: 5000 });

  const items = testId("switcher-model");
  const itemFit = await fits(items);
  check("no dropdown entry clips its own text", itemFit.ok, JSON.stringify(itemFit.overflowing));

  const itemBox = await items.first().boundingBox();
  check(
    "a dropdown entry is taller than the 24px menu row",
    itemBox.height > 24,
    `${itemBox.height}px`,
  );

  await page.keyboard.press("Escape");

  // ---------------------------------------------------------------------------
  // Creating a model, which until now meant leaving the app for a terminal.
  // ---------------------------------------------------------------------------

  // Arrive at it the way the dead end used to go: browsing to a folder with no
  // model in it, which had nothing to offer but the name of a CLI command.
  await testId("open-model").click();
  await testId("open-model-dialog").waitFor({ timeout: 5000 });
  await testId("browse-path").waitFor({ timeout: 10000 });

  check(
    "the browser starts in the home directory",
    (await testId("browse-path").innerText()).trim() === homedir(),
    await testId("browse-path").innerText(),
  );
  check(
    "a folder with no model cannot be opened",
    await testId("open-this-folder").isDisabled(),
  );
  check("but it offers to create one there", (await testId("create-here").count()) === 1);

  await testId("create-here").click();
  await testId("new-model-dialog").waitFor({ timeout: 5000 });
  // The dialog being replaced is still in the DOM through its close animation,
  // and both carry a browser — so from here on, ask the one that is arriving.
  await testId("open-model-dialog").waitFor({ state: "detached", timeout: 5000 });
  check(
    "the handoff keeps the folder that was being looked at",
    (await testId("browse-path").innerText()).trim() === homedir(),
    await testId("browse-path").innerText(),
  );

  await testId(`browse-entry-${SCRATCH_NAME}`).click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="browse-path"]')?.textContent?.trim() ===
      expected,
    SCRATCH,
    { timeout: 10000 },
  );

  check(
    "Create is refused until the model has a name",
    await testId("create-model").isDisabled(),
  );

  await testId("new-model-name").fill(MODEL_NAME);
  check(
    "the target path is the folder and the name",
    (await testId("new-model-target").innerText()).trim() === join(SCRATCH, MODEL_NAME),
    await testId("new-model-target").innerText(),
  );

  await testId("create-model").click();

  // Landing in the shell is the assertion: creating and opening are one action.
  // Waited for rather than read once — the shell is *already* on screen, showing
  // the previous model, so there is nothing to appear, only a name to change.
  const switched = await page
    .waitForFunction(
      (name) =>
        document
          .querySelector('[data-testid="project-switcher"]')
          ?.textContent?.includes(name),
      MODEL_NAME,
      { timeout: 30000 },
    )
    .then(() => true)
    .catch(() => false);
  check(
    "the created model is the one now open",
    switched,
    await testId("project-switcher").innerText(),
  );
  await testId("model-tree").waitFor({ timeout: 30000 });
  check(
    "and it is a real model on disk",
    Boolean(await stat(join(SCRATCH, MODEL_NAME, "model.yaml")).catch(() => null)),
  );

  await testId("project-switcher").click();
  await testId("switcher-model").first().waitFor({ timeout: 5000 });
  const names = await testId("switcher-model").allInnerTexts();
  check(
    "and it appears in the picker it was created from",
    names.some((text) => text.includes(MODEL_NAME)),
    names.join(" | "),
  );
  await page.keyboard.press("Escape");
} finally {
  // Whatever happened above: the scratch model leaves no trace, on disk or in
  // the user's recents list.
  const projects = await (await api(`${BASE}/api/projects/`)).json();
  for (const project of projects) {
    if (project.description?.startsWith(SCRATCH)) {
      await api(`${BASE}/api/projects/${project.id}/`, { method: "DELETE" });
    }
  }
  await rm(SCRATCH, { recursive: true, force: true });
}

check("no console errors throughout", consoleErrors.length === 0);

await finish(browser, consoleErrors);
