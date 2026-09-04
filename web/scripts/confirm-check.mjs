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
import { baseFrom, openWorkspace, quiet, results, until } from "./harness.mjs";

const BASE = baseFrom(process.argv);

const { check, skip, finish } = results("confirm");
const { browser, page, testId, consoleErrors, calls, enter } = await openWorkspace(BASE);

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

console.log(`Unsaved-changes guard at ${BASE}`);

try {
  // -- a clean model leaves without asking ----------------------------------
  await enter();
  await leave();
  await testId("recent-models").waitFor({ timeout: 10000 });
  check("a clean model leaves without asking", true);
  // The one place a fixed wait is right: asserting something does *not* happen.
  await quiet(400);
  check("and no dialog was raised", !(await testId("confirm-dialog").isVisible()));

  // -- dirty a tab -----------------------------------------------------------
  await enter();
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

  // -- the override picker, which is a popup over a popup --------------------
  //
  // `MultiSelect` is a Popover wrapping the Command list, and nothing else in
  // the suite opens one — so its whole component tree, which two editors put in
  // front of users, was drawn by no check at all. Placement is the assertion
  // that matters, for `menu-check`'s reason: Reka parks a popper at
  // `translate(0, -200%)` until floating-ui gives it an anchor, and there it
  // stays clickable by a script while being invisible to a person.
  const picker = testId("scenario").first().getByRole("combobox").first();
  const options = () => page.locator('[data-slot="command-item"]');
  await picker.click();
  await page.locator('[data-slot="command-list"]').waitFor({ timeout: 8000 });
  await quiet(400);

  const where = await page.evaluate(() => {
    const content = document.querySelector('[data-slot="popover-content"]');
    if (!content) return null;
    const box = content.getBoundingClientRect();
    return {
      anchored: (content.parentElement?.getAttribute("style") ?? "").includes(
        "--reka-popper-anchor-width",
      ),
      onScreen:
        box.width > 0 &&
        box.height > 0 &&
        box.top >= 0 &&
        box.bottom <= window.innerHeight &&
        box.right <= window.innerWidth,
    };
  });
  check("the override picker anchors to its trigger", where?.anchored === true, JSON.stringify(where));
  check("and opens where it can be seen", where?.onScreen === true, JSON.stringify(where));

  const offered = await options().count();
  if (offered === 0) {
    skip("picking an override (this model defines none)");
  } else {
    const first = (await options().first().innerText()).trim();
    const before = (await picker.innerText()).trim();
    await options().first().click();
    // The trigger summarises rather than lists — badges up to a character
    // budget and then a count — and clicking an option that is already chosen
    // takes it out again. Either way the trigger has to say something new, or
    // the pick reached no model at all.
    await until(async () => (await picker.innerText()).trim() !== before);
    check(
      "picking an override changes what the trigger says",
      (await picker.innerText()).trim() !== before,
      `${first}: "${before}" -> "${(await picker.innerText()).trim()}"`,
    );

    // The list is searchable because a model may define dozens; a filter that
    // matched nothing used to be the only way to discover it had one.
    const search = page.getByPlaceholder("Search…").or(page.locator('[data-slot="command-input"]'));
    await search.first().fill(first.slice(0, 3));
    await until(async () => (await options().count()) > 0);
    check("typing narrows the list", (await options().count()) <= offered);

    await search.first().fill("no_such_override_anywhere");
    await page.locator('[data-slot="command-empty"]').waitFor({ timeout: 5000 });
    check("and a query that matches nothing says so", true);
  }

  await page.keyboard.press("Escape");
  await quiet(300);
  check("Escape closes the picker", !(await page.locator('[data-slot="command-list"]').isVisible()));

  // -- removing an entry asks the same way ----------------------------------
  // A scenario owns its list of overrides, so taking it out of the form goes
  // through the same dialog; a single override inside one does not.
  const dialog = testId("confirm-dialog");
  const scenarios = await testId("scenario").count();
  await testId("entry-remove").first().click();
  await dialog.waitFor({ timeout: 8000 });
  check("removing a scenario asks first", true);
  check(
    "and names that act too",
    (await testId("confirm-accept").innerText()).trim() === "Remove",
  );
  await testId("confirm-cancel").click();
  await dialog.waitFor({ state: "hidden", timeout: 8000 });
  check("declining keeps the scenario", (await testId("scenario").count()) === scenarios);

  // -- cancelling keeps everything ------------------------------------------
  await leave();
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
