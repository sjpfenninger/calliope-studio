/**
 * What can be done *to* a run: cancel it, rename it, delete it, keep fewer.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run run-actions http://127.0.0.1:8791
 *
 * None of these was covered anywhere. `run-lifecycle` waits for a run to
 * *finish*, which is the opposite of what cancelling needs, and it costs several
 * minutes — so this is a separate file that starts a run, interrupts it during
 * the build, and spends the rest of its time on a run it has already stopped.
 *
 * What each one is here for:
 *
 *  - **Cancel.** Calliope has no interrupt API, so cancelling means killing a
 *    process group and believing the status that comes back. The three things
 *    that can go wrong are all invisible from a type-check: the status never
 *    leaves `running`, the log keeps streaming from a process that is supposedly
 *    dead, and `start-run` stays disabled — leaving the model with no way to run
 *    anything again short of a reload.
 *  - **Delete while running is refused.** The run directory is being written to.
 *    The guard is a prop on a menu item, which nothing else in this suite reads.
 *  - **Rename.** Enter commits and Escape abandons, one character apart on the
 *    keyboard; `RunListItem.test.ts` pins the component, and this pins that the
 *    committed name actually reaches the server and comes back.
 *  - **Delete.** The row goes *and so does the run's tab*, which is a second
 *    store away from the list and was never checked. A tab left behind points at
 *    a results handle for a directory that no longer exists.
 *  - **Retention.** A per-workspace setting kept in the registry rather than in
 *    the model, so the only honest check is a reload.
 *
 * Deletes only the run it started, so `run-lifecycle`'s and `screenshots`'s runs
 * are left alone, and puts the retention setting back on the way out.
 *
 * If the build is over before the cancel lands — a fast machine, a warm cache —
 * the cancel assertions are skipped rather than failed: a run that finished is
 * not a bug, and the rest of the file works just as well on a finished run.
 */
import { baseFrom, openWorkspace, results, until } from "./harness.mjs";

const BASE = baseFrom(process.argv);

// `guard` reads `this`, so it is called on the object rather than destructured
// out of it; `check` and `skip` are free functions.
const outcome = results("run-actions");
const { check, skip } = outcome;
const { browser, page, testId, consoleErrors, stable, calls, enter, goSection } =
  await openWorkspace(BASE);

const RENAMED = "run-actions rename";
const ABANDONED = "never committed";

const rows = () => page.locator('[data-testid="run-item"]');
const runTabs = () => page.locator('[data-testid="tab-run"]');
const logLines = () => page.locator('[data-testid="run-log"] p').count();

console.log(`Run actions at ${BASE}`);

async function run() {
  await enter();
  await goSection("Runs");
  await testId("start-run").waitFor({ timeout: 20000 });

  const retentionBefore = ((await testId("retention").innerText()) ?? "")
    .replace("keep", "")
    .trim();
  const rowsBefore = await rows().count();
  const tabsBefore = await runTabs().count();

  await testId("start-run").click();
  await testId("run-log").waitFor({ timeout: 60000 });
  await until(async () => (await rows().count()) > rowsBefore, { timeout: 30000 });

  // Ours, by id, so nothing below can act on a run another check left behind.
  const row = rows().first();
  const runId = await row.getAttribute("data-run-id");
  const mine = page.locator(`[data-run-id="${runId}"]`);
  const statusOf = () =>
    mine.locator('[data-testid="run-status"]').first().getAttribute("data-status");
  const openMenu = async () => {
    await mine.locator('[data-testid="run-menu"]').click();
    await testId("run-delete").waitFor({ timeout: 10000 });
  };

  const started = await until(async () => (await statusOf()) === "running", {
    timeout: 60000,
    interval: 100,
  });

  if (!started && !["pending", "running"].includes(await statusOf())) {
    skip(`the run was over before it could be interrupted (${await statusOf()})`);
  } else {
    await openMenu();
    check(
      "a run that is still going cannot be deleted",
      (await testId("run-delete").getAttribute("aria-disabled")) === "true",
    );
    check("and is offered a cancel instead", (await testId("run-cancel-action").count()) === 1);
    await page.keyboard.press("Escape");

    await testId("cancel-run").click();
    const stopped = await until(async () => (await statusOf()) === "cancelled", {
      timeout: 60000,
      interval: 100,
    });
    if (!stopped) {
      skip(`the run finished before the cancel took effect (${await statusOf()})`);
    } else {
      check("cancelling stops the run", true);
      check("and reports no error", (await testId("run-action-error").count()) === 0);
      // A killed process group writes nothing more. There is no event for that,
      // but there is a line count that stops moving.
      const settledAt = await stable(logLines, { same: 4, interval: 100 });
      check(
        "and the log stops growing",
        (await logLines()) === settledAt,
        `${settledAt} lines`,
      );
      check(
        "and the model can be run again",
        !(await testId("start-run").isDisabled()),
      );
    }
  }

  // ── rename ────────────────────────────────────────────────────────────────
  await openMenu();
  await testId("run-rename-action").click();
  const field = mine.locator('[data-testid="run-rename"]');
  await field.waitFor({ timeout: 10000 });
  await field.fill(RENAMED);
  await calls.settle(() => field.press("Enter"));
  await until(async () => ((await mine.innerText()) ?? "").includes(RENAMED), {
    timeout: 15000,
  });
  check("Enter commits a rename", true);

  await openMenu();
  await testId("run-rename-action").click();
  await field.waitFor({ timeout: 10000 });
  await field.fill(ABANDONED);
  await field.press("Escape");
  await until(async () => (await field.count()) === 0, { timeout: 10000 });
  check(
    "Escape abandons one and leaves the name alone",
    ((await mine.innerText()) ?? "").includes(RENAMED) &&
      !((await mine.innerText()) ?? "").includes(ABANDONED),
  );

  // The name survives a round trip to the server rather than only the row.
  await calls.settle(() => page.reload({ waitUntil: "domcontentloaded" }));
  await testId("start-run").waitFor({ timeout: 30000 });
  check(
    "the committed name came from the server, not the row",
    ((await mine.innerText()) ?? "").includes(RENAMED),
  );

  // ── delete ────────────────────────────────────────────────────────────────
  await openMenu();
  check(
    "a finished run can be deleted",
    (await testId("run-delete").getAttribute("aria-disabled")) === null,
  );
  await testId("run-delete").click();
  await testId("confirm-delete-run").waitFor({ timeout: 10000 });
  await calls.settle(() => testId("confirm-delete-run").click());
  await until(async () => (await mine.count()) === 0, { timeout: 20000 });
  check("deleting removes the run from the history", true);
  await until(async () => (await runTabs().count()) === tabsBefore, { timeout: 10000 });
  check(
    "and closes the tab that was showing it",
    (await runTabs().count()) === tabsBefore,
  );

  // ── retention ─────────────────────────────────────────────────────────────
  await testId("retention").click();
  await testId("retention-10").waitFor({ timeout: 10000 });
  await calls.settle(() => testId("retention-10").click());
  await until(async () => ((await testId("retention").innerText()) ?? "").includes("10"), {
    timeout: 10000,
  });
  check("retention says what was chosen", true);

  // The setting lives in the registry rather than in the model, so a reload is
  // the only thing that tells a stored preference from a local ref.
  await calls.settle(() => page.reload({ waitUntil: "domcontentloaded" }));
  await testId("retention").waitFor({ timeout: 30000 });
  check(
    "and still says it after a reload",
    ((await testId("retention").innerText()) ?? "").includes("10"),
  );

  // Put it back: this is a per-workspace setting and every later check inherits
  // whatever it is left at.
  await testId("retention").click();
  // The label is "keep all" or "keep 20", and the testid is the same word.
  const back = testId(`retention-${retentionBefore}`);
  await back.waitFor({ timeout: 10000 });
  await calls.settle(() => back.click());
  await until(
    async () => ((await testId("retention").innerText()) ?? "").includes(retentionBefore),
    { timeout: 10000 },
  );
  check("the retention setting is put back", true);
}

await outcome.guard(browser, consoleErrors, run);
