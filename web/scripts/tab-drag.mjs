/**
 * Tabs are dragged into an order, and the bar has a left end.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run tab-drag http://127.0.0.1:8791
 *
 * Four things a vitest cannot reach, because each of them is either a real drag
 * or a measured pixel:
 *
 * - **The drag survives the reorder it causes.** The order is applied while the
 *   pointer is still down, so the element being dragged is re-parented mid-drag.
 *   Vue moves it because the `v-for` is keyed by the tab's id — key it by index
 *   and the row is rebuilt instead, which cancels the drag in Chromium and leaves
 *   the tab wherever the first swap put it. The probe below is element identity,
 *   not order, because order alone cannot tell the two apart on a single swap.
 * - **The tab is not droppable anywhere else.** A drag payload offered as
 *   `text/plain` is one Monaco will take, so releasing a tab over the editor
 *   pastes its id into the user's file — a silent edit to a model, from a gesture
 *   that looks like it did nothing.
 * - **The order is what the next session reopens.** Nothing writes it explicitly;
 *   it falls out of the Map's key order reaching `persist`, which is exactly the
 *   kind of thing that works until someone adds an order array beside it.
 * - **The strip's left end draws a boundary.** With the first tab inactive it and
 *   the back/forward well are both `bg-panel`, so a missing rule is not a visible
 *   error — it is an absence, which is why this is measured rather than looked at.
 *
 * It only opens and reorders tabs, so it writes nothing to the model and has
 * nothing to clean up.
 */
import { api, health, open, quiet, requireMode, results } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";

const { check, finish, failed } = results("tab-drag");

const payload = requireMode(await health(BASE), "workspace", BASE);
const ws = payload.workspace_id;

/** Three YAML files, whatever the model happens to be. */
const listed = await (await api(`${BASE}/api/versions/${ws}/files/`)).json();
const files = listed
  .filter((entry) => entry.type !== "directory" && entry.path.endsWith(".yaml"))
  .map((entry) => entry.path)
  .slice(0, 3);

if (files.length < 3) {
  console.error(`This check needs three YAML files; ${payload.workspace} has ${files.length}.`);
  process.exit(2);
}

const { browser, page, consoleErrors, testId, until } = await open();

const tabAt = (id) => page.locator(`[data-tab-id="${id}"]`);
const order = () =>
  page.locator("[data-tab-id]").evaluateAll((els) => els.map((el) => el.dataset.tabId));

/**
 * Drags one tab onto another with a real pointer.
 *
 * Aimed at the *far* edge of the target rather than its centre: the reorder only
 * fires once the pointer is past the target's midpoint in the direction of
 * travel, which is what stops two tabs of unequal width trading places forever.
 * More than one intermediate move because a single one does not start an HTML5
 * drag at all.
 */
async function drag(fromId, toId) {
  const ids = await order();
  const rightwards = ids.indexOf(fromId) < ids.indexOf(toId);
  const from = await tabAt(fromId).boundingBox();
  const to = await tabAt(toId).boundingBox();

  const y = from.y + from.height / 2;
  await page.mouse.move(from.x + from.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, y, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.move(rightwards ? to.x + to.width - 3 : to.x + 3, to.y + to.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
}

try {
  await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Files" }).click();
  await testId("file-tree").waitFor({ timeout: 20000 });

  // ── three permanent tabs ──────────────────────────────────────────────────
  //
  // Modified-click, because a plain one previews: the preview slot holds exactly
  // one tab, so three plain clicks leave one tab and nothing to drag.
  for (const path of files) {
    await testId("file-search").fill(path);
    const row = page.locator(`[data-testid="file-tree"] [role="treeitem"]`, {
      hasText: path.split("/").pop(),
    });
    await row.first().click({ modifiers: ["ControlOrMeta"] });
    await until(async () => (await order()).includes(`file:${path}`));
  }
  await testId("file-search").fill("");

  const opened = await order();
  check("three tabs are open", opened.length === 3, opened.join(", "));

  // ── the left end of the strip ─────────────────────────────────────────────
  const lead = testId("tab-lead");
  const subtle = await lead.evaluate((el) => {
    const style = getComputedStyle(el);
    return { width: style.borderRightWidth, color: style.borderRightColor };
  });
  check("the nav well draws a separator", subtle.width === "1px", JSON.stringify(subtle));
  check(
    "the separator is painted, not transparent",
    !/rgba\([^)]*,\s*0\)/.test(subtle.color),
    subtle.color,
  );

  const seam = await lead.evaluate((el) => {
    const well = el.getBoundingClientRect();
    const first = document.querySelector("[data-tab-id]").getBoundingClientRect();
    return { wellRight: well.right, tabLeft: first.left };
  });
  check(
    "it sits between the arrows and the first tab",
    Math.abs(seam.wellRight - seam.tabLeft) <= 1,
    JSON.stringify(seam),
  );

  // Same rule the tab separators follow: the boundary before the active tab goes
  // to full strength. Two strengths that resolve to one colour is the failure
  // this catches, and it looks like nothing at all.
  await tabAt(opened[0]).click();
  await until(async () => (await tabAt(opened[0]).getAttribute("data-active")) !== null);
  const strong = await lead.evaluate((el) => getComputedStyle(el).borderRightColor);
  check("it strengthens when the first tab is active", strong !== subtle.color, strong);

  // ── dragging ──────────────────────────────────────────────────────────────
  //
  // The element, not just the order: this is the one that fails if the row is
  // rebuilt rather than moved.
  await page.evaluate((id) => {
    window.__cgDragProbe = document.querySelector(`[data-tab-id="${id}"]`);
  }, opened[0]);

  await drag(opened[0], opened[2]);
  await until(async () => (await order())[2] === opened[0]);
  check(
    "a tab dragged to the right lands at the end",
    (await order()).join() === [opened[1], opened[2], opened[0]].join(),
    (await order()).join(", "),
  );
  check(
    "the drag moved the element rather than rebuilding it",
    await page.evaluate(
      (id) => document.querySelector(`[data-tab-id="${id}"]`) === window.__cgDragProbe,
      opened[0],
    ),
  );

  await drag(opened[0], opened[1]);
  await until(async () => (await order())[0] === opened[0]);
  check(
    "and back to the left",
    (await order()).join() === [opened[0], opened[1], opened[2]].join(),
    (await order()).join(", "),
  );

  // ── the payload nobody else may take ──────────────────────────────────────
  const types = await page.evaluate((id) => {
    const el = document.querySelector(`[data-tab-id="${id}"]`);
    const data = new DataTransfer();
    el.dispatchEvent(new DragEvent("dragstart", { dataTransfer: data, bubbles: true }));
    const offered = [...data.types];
    el.dispatchEvent(new DragEvent("dragend", { dataTransfer: data, bubbles: true }));
    return offered;
  }, opened[0]);
  check("the drag carries a payload at all", types.length > 0, JSON.stringify(types));
  check(
    "it is not text, which Monaco would accept",
    !types.includes("text/plain"),
    JSON.stringify(types),
  );

  // And the same thing end to end: a tab released over the editor edits nothing.
  // `quiet` because the assertion is that nothing happened.
  await page.locator(".monaco-editor").first().waitFor({ timeout: 20000 });
  const editor = await page.locator(".monaco-editor").first().boundingBox();
  const source = await tabAt(opened[0]).boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2, {
    steps: 4,
  });
  await page.mouse.move(editor.x + editor.width / 2, editor.y + editor.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await quiet(400);
  check(
    "dropping a tab on the editor does not edit the file",
    (await testId("tab-dirty").count()) === 0,
  );

  // ── the order is remembered ───────────────────────────────────────────────
  await drag(opened[0], opened[2]);
  await until(async () => (await order())[2] === opened[0]);
  const settled = await order();

  await page.reload({ waitUntil: "domcontentloaded" });
  await until(async () => (await order()).length === 3);
  check(
    "the order survives a reload",
    (await order()).join() === settled.join(),
    `${(await order()).join(", ")} vs ${settled.join(", ")}`,
  );

  // ── and `?tab=` beats what it remembered ──────────────────────────────────
  //
  // A link to a tab has to win over the last session's active one, which is why
  // `restore` hands the id back instead of activating it. Nothing else in the
  // suite covers the losing half of that race.
  const remembered = await page
    .locator("[data-tab-id][data-active]")
    .first()
    .getAttribute("data-tab-id");
  const wanted = settled.find((id) => id !== remembered);
  await page.goto(`${page.url().split("?")[0]}?tab=${encodeURIComponent(wanted)}`, {
    waitUntil: "domcontentloaded",
  });
  await until(async () => (await order()).length === 3);
  const fronted = await until(
    async () =>
      (await page.locator("[data-tab-id][data-active]").first().getAttribute("data-tab-id")) ===
      wanted,
  );
  check("?tab= wins over the remembered active tab", fronted, `wanted ${wanted}`);
} catch (error) {
  check("the check ran to the end", false, String(error));
} finally {
  await finish(browser, failed() ? consoleErrors : []);
}
