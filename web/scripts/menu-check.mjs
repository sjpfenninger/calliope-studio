/**
 * Every popup actually lands where the user can see it.
 *
 *   pnpm run menu-check http://127.0.0.1:8791
 *
 * This exists because of a failure that every other check was blind to. Reka
 * positions a popper with floating-ui and, until that has run, parks the content
 * at `transform: translate(0, -200%)` — off the top of the window. If the popper
 * never gets an anchor, it stays there: the menu opens, takes focus, sets
 * `pointer-events: none` on the body and traps the pointer, all while sitting
 * several hundred pixels above the viewport. Nothing appears.
 *
 * The DOM is entirely healthy in that state. `[role="menu"]` exists, its items
 * exist and are clickable by a script, `isVisible()` is true, and no console
 * error is raised — which is exactly why `run-lifecycle` asserted "a run's
 * action menu still opens under its tooltip" and passed while the menu was
 * invisible to a human. **Presence is not the property; position is.**
 *
 * The cause was structural: an `InfoTip` — a Reka `Tooltip`, which provides a
 * popper context of its own — sitting *between* a `DropdownMenu` and its
 * trigger. The trigger registered its anchor into the tooltip's popper, so the
 * menu's had none. The two menus wrapped that way were broken; the one that was
 * not was fine. Nothing about that is visible in a diff, so it is checked here.
 */
import { health, open, quiet, requireMode, results, trackRequests } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";
const payload = requireMode(await health(BASE), "workspace", BASE);

const { check, finish } = results("menus");
const { browser, page, testId, consoleErrors } = await open();
const calls = trackRequests(page, (request) => request.url().includes("/api/"));

/**
 * Where the open popup actually is.
 *
 * `anchored` reads the popper's own bookkeeping: Reka writes
 * `--reka-popper-anchor-width` onto the wrapper only once it has measured a
 * reference element, so its absence is the precise signature of the bug rather
 * than a symptom of it. The geometry is then checked independently, because an
 * anchored popper can still be pushed off-screen by a collision boundary.
 */
const placed = (selector) =>
  page.evaluate((sel) => {
    const content = document.querySelector(sel);
    if (!content) return null;
    const style = content.parentElement?.getAttribute("style") ?? "";
    const box = content.getBoundingClientRect();
    return {
      anchored: style.includes("--reka-popper-anchor-width"),
      onScreen:
        box.width > 0 &&
        box.height > 0 &&
        box.top >= 0 &&
        box.left >= 0 &&
        box.bottom <= window.innerHeight &&
        box.right <= window.innerWidth,
      at: `${Math.round(box.x)},${Math.round(box.y)}`,
    };
  }, selector);

const MENU = '[role="menu"]';

/** Opens something, checks where it landed, and closes it again. */
async function popup(label, openIt, selector = MENU) {
  await openIt();
  // Placement happens in a floating-ui effect after the content mounts, so this
  // waits for the element and then for one settled frame — not for a duration.
  await page.locator(selector).first().waitFor({ timeout: 8000 }).catch(() => {});
  await quiet(400);
  const where = await placed(selector);
  check(`${label} is anchored to its trigger`, where?.anchored === true, JSON.stringify(where));
  check(`${label} is inside the viewport`, where?.onScreen === true, JSON.stringify(where));
  await page.keyboard.press("Escape");
  await quiet(300);
}

console.log(`Popup placement at ${BASE}`);

try {
  await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
  await testId("model-tree").waitFor({ timeout: 20000 });
  await calls.idle();

  // The model switcher: the one dropdown with no tooltip around it, and so the
  // control that showed the other two were the odd ones out.
  await popup("the model switcher menu", () => testId("project-switcher").click());

  await calls.settle(() => page.getByRole("link", { name: /Runs/i }).first().click());
  await quiet(400);

  // Wrapped in an InfoTip, which is what broke it.
  await popup("the retention menu", () => testId("retention").first().click());

  // The *other* InfoTip-wrapped menu — a run's actions — is asserted by
  // `run-lifecycle`, which owns a run and so has a row to open one on. It used
  // to be here too, and passed only because a developer's `example-model`
  // accumulates runs from earlier checks: against the freshly scaffolded model
  // CI builds there is no `run-item` at all, and the hover sat out its full
  // thirty-second timeout. A check should not depend on state it does not
  // create.

  // A tooltip is the same popper layer, and was never broken — so it is the
  // control that says a failure here is about the menu and not about floating-ui.
  await testId("retention").first().hover();
  await page
    .locator('[data-slot="tooltip-content"]')
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  const tip = await placed('[data-slot="tooltip-content"]');
  check("a tooltip still places itself", tip?.anchored === true, JSON.stringify(tip));
} catch (error) {
  check("the check ran to completion", false, error.message.split("\n")[0]);
} finally {
  await finish(browser, consoleErrors);
}
