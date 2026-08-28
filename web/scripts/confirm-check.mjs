/**
 * The unsaved-changes guard, which is the app's most consequential dialog.
 *
 *   pnpm run confirm-check http://127.0.0.1:8791
 *
 * It stands between a user and losing edits they have not written to disk, and
 * until recently it was a `window.confirm` — the one OS-drawn surface in an app
 * whose design contract bans the native `title` attribute for exactly that
 * reason. Replacing it moved the decision into `stores/confirm` and a dialog
 * rendered from `App.vue`, above the router view, because the guard fires while
 * the shell is being *left* and a dialog inside that tree unmounts as it opens.
 *
 * Three things need a browser to check, and none of them is visible to vue-tsc:
 *
 * - **The dialog appears at all.** `beforeEach` may return a promise, so the
 *   navigation waits for it. If that contract ever breaks the guard silently
 *   becomes a no-op and the edits are simply gone — a failure with no error and
 *   no console output.
 * - **Cancelling actually cancels.** The interesting half is not the dialog, it
 *   is that the navigation does not happen: the route, the editor and the buffer
 *   all have to survive.
 * - **A clean model does not ask.** A guard that prompts on every exit gets
 *   dismissed by reflex, which is worse than not having one.
 *
 * **A full page load does not exercise this.** `page.goto` is a browser
 * navigation that vue-router never sees, and neither did `window.confirm` —
 * that is `beforeunload`, a different mechanism entirely. Every navigation here
 * goes through the app's own UI, which is the only path the guard is on.
 *
 * The same guard stands on a tab's own close button, which discards the same
 * buffer without leaving the shell. Middle-click shares the code path, so the
 * X is the one exercised here.
 */
import { health, open, quiet, requireMode, results, trackRequests } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";
const payload = requireMode(await health(BASE), "workspace", BASE);

const { check, finish } = results("confirm");
const { browser, page, testId, consoleErrors } = await open();
const calls = trackRequests(page, (request) => request.url().includes("/api/"));

// If the native dialog ever comes back, this records it rather than letting
// Playwright auto-dismiss it and the check pass on a prompt nobody saw.
const natives = [];
await page.exposeFunction("__cgNativeConfirm", (message) => natives.push(message));
await page.addInitScript(() => {
  window.confirm = (message) => {
    window.__cgNativeConfirm?.(String(message));
    return true;
  };
});

/** Leaves the model the way a user does: the switcher's "Recent models…". */
const leave = async () => {
  await testId("project-switcher").click();
  await page.getByRole("menuitem", { name: /Recent models/ }).click();
};

const enterShell = async () => {
  await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
  await testId("model-tree").waitFor({ timeout: 20000 });
  await calls.idle();
};

console.log(`Unsaved-changes guard at ${BASE}`);

try {
  // -- a clean model leaves without asking ----------------------------------
  await enterShell();
  await leave();
  await testId("recent-models").waitFor({ timeout: 10000 });
  check("a clean model leaves without asking", true);
  // The one place a fixed wait is right: asserting something does *not* happen.
  await quiet(400);
  check("and no dialog was raised", !(await testId("confirm-dialog").isVisible()));

  // -- dirty a tab -----------------------------------------------------------
  await enterShell();
  await calls.settle(() =>
    page.getByRole("treeitem", { name: /^scenarios$/i }).first().click(),
  );
  await testId("scenarios-editor").waitFor({ timeout: 15000 });

  const field = testId("scenario").first().locator("input").first();
  await field.click();
  await field.press("x");
  // The dot is the app's own answer to "is this unsaved", so waiting for it
  // beats waiting for a duration and then hoping.
  await testId("tab-dirty").first().waitFor({ timeout: 5000 });
  check("typing into an editor marks its tab unsaved", true);

  // -- cancelling keeps everything ------------------------------------------
  await leave();
  const dialog = testId("confirm-dialog");
  await dialog.waitFor({ timeout: 8000 });
  check("leaving with unsaved changes asks first", true);
  check(
    "the action is named rather than 'OK'",
    (await testId("confirm-accept").innerText()).trim() === "Leave",
  );

  await testId("confirm-cancel").click();
  await dialog.waitFor({ state: "hidden", timeout: 8000 });
  check("cancelling closes the dialog", true);
  check("and the navigation did not happen", page.url().includes("/versions/"));
  check("and the editor is still mounted", await testId("scenarios-editor").isVisible());
  check("and the tab is still unsaved", await testId("tab-dirty").first().isVisible());

  // -- closing an unsaved tab asks the same question -------------------------
  const activeTab = page.locator('[data-testid^="tab-"][data-active]').first();
  // The X only paints while the tab is hovered, so hover first or the click
  // waits on an element that stays display:none.
  await activeTab.hover();
  await activeTab.getByRole("button", { name: "Close tab" }).click();
  await dialog.waitFor({ timeout: 8000 });
  check("closing an unsaved tab asks first", true);
  check(
    "the close action is named too",
    (await testId("confirm-accept").innerText()).trim() === "Close tab",
  );

  await testId("confirm-cancel").click();
  await dialog.waitFor({ state: "hidden", timeout: 8000 });
  check("cancelling keeps the tab and its edits", await testId("tab-dirty").first().isVisible());

  await activeTab.hover();
  await activeTab.getByRole("button", { name: "Close tab" }).click();
  await dialog.waitFor({ timeout: 8000 });
  await testId("confirm-accept").click();
  await dialog.waitFor({ state: "hidden", timeout: 8000 });
  check(
    "accepting closes the tab",
    (await page.locator('[data-testid="tab-dirty"]').count()) === 0,
  );

  // -- accepting the leave really leaves -------------------------------------
  // The close above discarded the only dirty buffer, so dirty a fresh one.
  await calls.settle(() =>
    page.getByRole("treeitem", { name: /^scenarios$/i }).first().click(),
  );
  await testId("scenarios-editor").waitFor({ timeout: 15000 });
  const refield = testId("scenario").first().locator("input").first();
  await refield.click();
  await refield.press("x");
  await testId("tab-dirty").first().waitFor({ timeout: 5000 });

  await leave();
  await dialog.waitFor({ timeout: 8000 });
  await testId("confirm-accept").click();
  await testId("recent-models").waitFor({ timeout: 10000 });
  check("accepting leaves the model", !page.url().includes("/versions/"));

  check("no native confirm was used anywhere", natives.length === 0, natives.join(" | "));
} catch (error) {
  check("the check ran to completion", false, error.message.split("\n")[0]);
} finally {
  await finish(browser, consoleErrors);
}
