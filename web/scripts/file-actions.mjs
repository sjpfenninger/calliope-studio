/**
 * Creating files, and looking at ones that are not YAML.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run file-actions http://127.0.0.1:8791
 *
 * Three things that type-check clean and are still wrong if they are wrong:
 *
 * - **A binary must not reach Monaco.** Everything non-CSV used to go there, so
 *   a `.png` opened as a screenful of replacement characters — and as an
 *   *editable* one, which meant Ctrl/Cmd+S wrote that transcription back over
 *   the image. Both halves are checked: that the viewer says so, and that the
 *   bytes on disk survive a save keystroke.
 * - **An empty folder must survive a refresh.** The tree used to infer a
 *   directory from the `/` in a file's path, so a folder with nothing in it was
 *   created and then simply not there. Nothing throws; it just does not appear.
 * - **A rendered README must show the buffer, not the file.** Editing in Source
 *   and returning to Preview showing stale text looks exactly like the toggle
 *   being broken.
 *
 * Every fixture it makes is removed in the `finally`, and it refuses to start if
 * one is already there — the cleanup deletes them, so it must only ever delete
 * its own.
 */
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { api, health, open, quiet, requireMode, results } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";

/**
 * An 8×8 PNG of solid opaque blue — truecolour, no alpha channel.
 *
 * Opaque on purpose. The first fixture here was a transparent 1×1, which
 * decoded fine and painted nothing, and `naturalWidth > 0` was perfectly happy
 * about it: the pane was blank in a screenshot while the check passed. The
 * assertions below are geometry for the same reason.
 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNgyv+PFTEMLQkAs5VcAXffps4AAAAASUVORK5CYII=",
  "base64",
);

const README = `# Title

A paragraph with ~~strikethrough~~ and a [link](https://example.com).

| tech | carrier |
| ---- | ------- |
| ccgt | power   |

- [x] done
- [ ] not done
`;

/** Fixtures, and the folder the check creates through the UI. */
const IMAGE = "cg-check-diagram.png";
const BINARY = "cg-check-results.nc";
const DOC = "cg-check-readme.md";
const NEW_FILE = `cg-check-new-${Date.now()}.yaml`;
const NEW_FOLDER = `cg-check-folder-${Date.now()}`;

const { check, finish, failed } = results("file-actions");

const payload = requireMode(await health(BASE), "workspace", BASE);
const ws = payload.workspace_id;
const root = payload.workspace;

const exists = (path) =>
  stat(join(root, path)).then(
    () => true,
    () => false,
  );

for (const name of [IMAGE, BINARY, DOC, NEW_FILE, NEW_FOLDER]) {
  if (await exists(name)) {
    console.error(`${join(root, name)} already exists; this check would delete it.`);
    process.exit(2);
  }
}

// A `.nc` whose first bytes carry a NUL, which is what the server sniffs for.
await writeFile(join(root, BINARY), Buffer.from("CDF\x01\x00\x00\x00\x00binary junk"));
await writeFile(join(root, IMAGE), PNG);
await writeFile(join(root, DOC), README);

const { browser, page, consoleErrors, testId, until } = await open();

/**
 * Waits for a name to appear in the file tree, and answers whether it did.
 *
 * **Scoped to the tree, and evaluated once.** A page-wide `text=` match is
 * satisfied by the dialog that was just used to type the name — `NewFileDialog`
 * renders the full path into `new-entry-target` — and later by the tab as well.
 * Measured: with the dialog open, page-wide finds 1 and the tree finds 0, so a
 * page-wide wait returns immediately having seen nothing of the tree, and a
 * second query taken after the dialog unmounts finds nothing at all.
 *
 * That is why this assertion and the tab one traded places between CI runs:
 * whichever of dialog, row or tab happened to be mounted when the assertion
 * re-queried decided the result. Returning `until`'s own answer is the other
 * half — one observation, not two.
 */
const inTree = (name) =>
  until(async () => (await testId("file-tree").locator(`text=${name}`).count()) > 0);

/** Clicks a file in the tree and waits for the tab to be the front one. */
async function openFile(name) {
  await testId("file-search").fill(name);
  const row = page.locator(`[data-testid="file-tree"] [role="treeitem"]`, {
    hasText: name,
  });
  await row.first().click();
  await until(async () => (await testId("tab-file").count()) > 0);
}

try {
  await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Files" }).click();
  await testId("file-tree").waitFor({ timeout: 20000 });

  // ── the toolbar ──────────────────────────────────────────────────────────
  //
  // Presence is not the assertion. A popper that never got an anchor is in the
  // DOM, is "visible", and sits above the top of the window; a button clipped
  // out of its strip throws nothing either. Both are geometry questions.
  const strip = await testId("new-file").evaluate(
    (button) => button.parentElement.getBoundingClientRect().bottom,
  );
  for (const name of ["new-file", "new-folder"]) {
    const box = await testId(name).boundingBox();
    check(`${name} is rendered`, Boolean(box), "no bounding box");
    if (box) {
      check(
        `${name} sits inside the strip`,
        box.y >= 0 && box.y + box.height <= strip + 1,
        `button ${box.y}–${box.y + box.height}, strip ends ${strip}`,
      );
      check(`${name} is 24px, one size below the h-8 strip`, box.height === 24, `${box.height}px`);
    }
  }

  // ── creating a file ──────────────────────────────────────────────────────
  await testId("new-file").click();
  await until(async () => (await testId("new-file-dialog").count()) > 0);
  await testId("new-file-name").fill(NEW_FILE);
  check("the dialog previews the path it will create",
    (await testId("new-entry-target").textContent())?.trim() === NEW_FILE);
  await testId("create-file").click();
  await until(async () => await exists(NEW_FILE));

  check("the new file is on disk", await exists(NEW_FILE));
  check("the new file is in the tree", await inTree(NEW_FILE));
  // Polled, like the two above it. `afterCreate` awaits the file-tree reload
  // before it calls `openFile`, so the tree and the tab land in different ticks
  // with a render between them — close enough to simultaneous on a developer's
  // machine, not on a CI runner. `until` returns a boolean rather than throwing,
  // so a real regression still fails here instead of hanging.
  check(
    "the new file opened in a tab",
    await until(
      async () => (await testId("tab-file").filter({ hasText: NEW_FILE }).count()) > 0,
    ),
  );

  // ── a name that is already taken ─────────────────────────────────────────
  await testId("new-file").click();
  await until(async () => (await testId("new-file-dialog").count()) > 0);
  await testId("new-file-name").fill(NEW_FILE);
  check(
    "a name already in use disables Create",
    await testId("create-file").isDisabled(),
  );
  await page.keyboard.press("Escape");

  // ── creating a folder ────────────────────────────────────────────────────
  //
  // The one that could not work before directories became listing entries: an
  // empty folder was created and then not in the tree, because the tree was
  // built out of the `/` in file paths.
  await testId("new-folder").click();
  await until(async () => (await testId("new-folder-dialog").count()) > 0);
  await testId("new-folder-name").fill(NEW_FOLDER);
  await testId("create-folder").click();
  await until(async () => await exists(NEW_FOLDER));

  const listed = await (await api(`${BASE}/api/versions/${ws}/files/`)).json();
  check(
    "an empty folder is listed as a directory",
    listed.some((entry) => entry.path === NEW_FOLDER && entry.type === "directory"),
  );
  // Same defect as the file above, and it has only been passing on luck: a
  // folder opens no tab, so it had one decoy fewer to be rescued by.
  check("the empty folder is in the tree", await inTree(NEW_FOLDER));

  // ── a binary file ────────────────────────────────────────────────────────
  await openFile(BINARY);
  await until(async () => (await testId("file-binary").count()) > 0);
  check("a binary says it cannot be displayed", (await testId("file-binary").count()) > 0);
  check(
    "a binary does not reach Monaco",
    (await page.locator(".monaco-editor").count()) === 0 ||
      !(await page.locator(".monaco-editor").first().isVisible()),
  );

  // The half that actually corrupted a file. `quiet` rather than a condition
  // because the assertion is that nothing happens, and there is no event for that.
  const beforeSave = await readFile(join(root, BINARY));
  await page.keyboard.press("ControlOrMeta+s");
  await quiet(400);
  const afterSave = await readFile(join(root, BINARY));
  check("Ctrl/Cmd+S leaves a binary byte-identical", beforeSave.equals(afterSave));

  // ── an image ─────────────────────────────────────────────────────────────
  await openFile(IMAGE);
  await until(async () => (await testId("file-image").count()) > 0);
  const drawn = await testId("file-image").evaluate((img) => {
    const box = img.getBoundingClientRect();
    const pane = img.parentElement.getBoundingClientRect();
    return {
      decoded: img.complete && img.naturalWidth > 0,
      box: { w: box.width, h: box.height, x: box.x, y: box.y },
      inside:
        box.width > 0 &&
        box.height > 0 &&
        box.x >= pane.x - 1 &&
        box.y >= pane.y - 1 &&
        box.right <= pane.right + 1 &&
        box.bottom <= pane.bottom + 1,
    };
  });
  check("an image is decoded", drawn.decoded);
  // Decoding is not drawing: a transparent or zero-boxed image decodes cleanly
  // and paints nothing, which no assertion about `naturalWidth` can tell apart.
  check(
    "the image occupies a real box inside the pane",
    drawn.inside,
    JSON.stringify(drawn.box),
  );

  // ── markdown ─────────────────────────────────────────────────────────────
  await openFile(DOC);
  await until(async () => (await testId("markdown-preview").count()) > 0);
  check("markdown opens rendered", (await testId("markdown-preview").count()) > 0);

  const preview = testId("markdown-preview");
  check("a GFM table renders as a table", (await preview.locator("table").count()) > 0);
  check("strikethrough renders", (await preview.locator("s").count()) > 0);
  check(
    "a task list renders as checkboxes",
    (await preview.locator('input[type="checkbox"]').count()) === 2,
  );
  check(
    "raw markdown is not left in the output",
    !(await preview.textContent())?.includes("~~"),
  );

  // Source → edit → Preview. The buffer, not the file: nothing is saved here.
  await testId("md-source").click();
  await until(async () => (await page.locator(".monaco-editor").first().isVisible()));
  await page.locator(".monaco-editor").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n\nAn unsaved sentence.\n");

  await testId("md-preview").click();
  await until(async () => (await testId("markdown-preview").count()) > 0);
  check(
    "the preview renders unsaved edits, not the file on disk",
    (await testId("markdown-preview").textContent())?.includes("An unsaved sentence."),
  );
  check(
    "the edit really was unsaved",
    !(await readFile(join(root, DOC), "utf8")).includes("An unsaved sentence."),
  );
} catch (error) {
  check("the check ran to the end", false, String(error));
} finally {
  for (const name of [IMAGE, BINARY, DOC, NEW_FILE, NEW_FOLDER]) {
    await rm(join(root, name), { recursive: true, force: true });
  }
  await finish(browser, failed() ? consoleErrors : []);
}
