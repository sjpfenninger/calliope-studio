/**
 * Comparing two versions of a model: the files, and what they mean.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run compare-check http://127.0.0.1:8791
 *
 * Never waits for a solve. A run cancelled during its build has already frozen
 * the model, and a frozen model is all a comparison needs — the Model half
 * resolves the snapshot rather than reading results out of it, which is the
 * mechanism that makes a failed run comparable at all and is therefore the one
 * worth exercising here.
 *
 * What is checked, and why each one is invisible to a type-check:
 *
 *  - **A comparison against an unedited model reports nothing.** This is the
 *    feature's version of "a no-op save must not change the file": a diff that
 *    invents differences sends somebody looking for an edit they never made.
 *    Both halves have to say it, because they answer independently.
 *  - **The diff editor actually renders two sides.** Monaco draws to its own
 *    DOM with no hook of ours in it, so the only honest evidence is its own
 *    decoration classes. A pane that mounted but painted nothing — a disposed
 *    model, a zero-height container — looks exactly like a file with no changes.
 *  - **An edit reaches both halves.** The Files half must mark the file, and
 *    the Model half must name the technology and the parameter — the two
 *    readings are computed from different sources and either can be wrong alone.
 *  - **A scenario comparison has no file differences but does have model ones.**
 *    The case with one folder on both sides, which is the whole reason a side
 *    is a folder *and* a scenario.
 *
 * Restores the file it edits and deletes the run it started, in a `finally`.
 */
import { baseFrom, openWorkspace, results, until } from "./harness.mjs";

const BASE = baseFrom(process.argv);

const outcome = results("compare-check");
const { check, skip } = outcome;
const { browser, page, testId, consoleErrors, calls, enter, goSection, files } =
  await openWorkspace(BASE);

/** The two files this check edits, and puts back. */
const TECHS = "model_config/techs.yaml";
const NODES = "model_config/locations.yaml";

/** A technology the model does not have, added to see how one is reported. */
const ADDED = `
  compare_check_wind:
    name: 'Compare-check wind'
    color: '#3B7BC1'
    base_tech: supply
    carrier_out: power
    flow_cap_max: 25000
    lifetime: 20
`;

const rows = () => page.locator('[data-testid="run-item"]');
const entities = () => page.locator('[data-testid="compare-entity"]');
const changed = () => page.locator('[data-testid="compare-entity"][data-status="changed"]');

console.log(`Compare at ${BASE}`);

/** Starts a run and stops it, leaving a frozen model behind. */
async function frozenRun() {
  const before = await rows().count();
  await testId("start-run").click();
  await testId("run-log").waitFor({ timeout: 60000 });
  await until(async () => (await rows().count()) > before, { timeout: 30000 });

  const runId = await rows().first().getAttribute("data-run-id");
  const mine = page.locator(`[data-run-id="${runId}"]`);
  const statusOf = () =>
    mine.locator('[data-testid="run-status"]').first().getAttribute("data-status");

  if (await until(async () => (await statusOf()) === "running", { timeout: 60000, interval: 100 })) {
    await testId("cancel-run").click();
  }
  // Either way it has to reach a terminal state before its snapshot is asked
  // about: a run mid-freeze has nothing to compare yet.
  await until(async () => ["cancelled", "success", "infeasible", "failed"].includes(await statusOf()), {
    timeout: 120000,
    interval: 200,
  });
  return { runId, mine };
}

async function openCompareFromRun(mine) {
  await mine.locator('[data-testid="run-menu"]').click();
  await testId("run-compare-model").waitFor({ timeout: 10000 });
  await testId("run-compare-model").click();
  await testId("compare-tab").waitFor({ timeout: 20000 });
}

/** The Model half answers only once Calliope has read both sides. */
const modelSettled = () =>
  until(
    async () =>
      (await testId("compare-model-empty").count()) > 0 || (await entities().count()) > 0,
    { timeout: 180000, interval: 500 },
  );

async function run() {
  await enter();
  await goSection("Runs");
  await testId("start-run").waitFor({ timeout: 20000 });

  const restore = await files.guard(TECHS, NODES);
  let runId = null;

  try {
    const started = await frozenRun();
    runId = started.runId;
    await openCompareFromRun(started.mine);

    check("a compare tab opens from the run menu", (await page.locator('[data-testid="tab-compare"]').count()) === 1);

    // ── Nothing edited: neither half may claim a difference ──────────────
    const settled = await modelSettled();
    if (!settled) {
      skip("Calliope did not finish reading both sides in time");
    } else {
      check(
        "an unedited model differs from the run in nothing",
        (await testId("compare-model-empty").count()) === 1,
      );

      // ── and draws it as one block, not two lines pinned to the pane ─────
      // `StateMessage`'s `fill` is a full-height grid, and a grid's
      // `align-content` defaults to stretch: without `content-center` the title
      // and its sentence each centre inside their own half of the pane, metres
      // apart, with the declared `gap-1.5` doing nothing. Every class is
      // correct in that state and jsdom does no layout, so a rendered page is
      // the only thing that can tell the two apart.
      const centred = await testId("compare-model-empty").evaluate((el) => {
        const lines = [...el.querySelectorAll("p")].map((p) => p.getBoundingClientRect());
        if (lines.length < 2) return null;
        const pane = el.closest('[data-testid="compare-model"]').getBoundingClientRect();
        return {
          gap: lines[1].top - lines[0].bottom,
          offset: Math.abs(
            (lines[0].top + lines.at(-1).bottom) / 2 - (pane.top + pane.height / 2),
          ),
          pane: pane.height,
        };
      });

      check(
        "and says so as one centred block, not two lines spread down the pane",
        centred !== null && centred.pane > 200 && centred.gap <= 16 && centred.offset <= 16,
        centred === null
          ? "fewer than two lines to measure"
          : `${Math.round(centred.gap)}px between the lines, ` +
            `${Math.round(centred.offset)}px off centre, in a ${Math.round(centred.pane)}px pane`,
      );
    }

    await testId("compare-subtab-files").click();
    await testId("compare-files").waitFor({ timeout: 20000 });
    check(
      "and neither do its files",
      (await testId("compare-files-empty").count()) === 1,
    );

    // ── One number changed ──────────────────────────────────────────────
    const original = await files.read(TECHS);
    const edited = original.replace(/flow_cap_max: 10000/, "flow_cap_max: 12345");
    if (edited === original) {
      skip(`${TECHS} does not contain the value this check edits`);
    } else {
      await files.write(TECHS, edited);
      await calls.settle(() => testId("compare-refresh").click(), { expect: 1 });

      const row = page.locator(
        `[data-testid="compare-file"][data-path="${TECHS}"][data-status="modified"]`,
      );
      await until(async () => (await row.count()) === 1, { timeout: 20000 });
      check("an edited file is marked as changed", (await row.count()) === 1);

      await row.click();
      await testId("diff-pane").waitFor({ timeout: 20000 });
      // Monaco's own decoration classes: it draws to a DOM of its own with no
      // hook of ours in it, and a pane that painted nothing looks identical to
      // a file with no changes.
      const deletions = page.locator('[data-testid="diff-pane"] .line-delete');
      const insertions = page.locator('[data-testid="diff-pane"] .line-insert');
      await until(async () => (await insertions.count()) > 0, { timeout: 20000 });
      check(
        "the diff editor paints both sides",
        (await deletions.count()) > 0 && (await insertions.count()) > 0,
      );

      await testId("compare-subtab-model").click();
      const found = await until(async () => (await changed().count()) > 0, {
        timeout: 180000,
        interval: 500,
      });
      if (!found) {
        const status = (await testId("compare-model-status").count())
          ? await testId("compare-model-status").innerText()
          : "no status shown";
        check("the model half reports the edit", false, status);
      } else {
        const first = changed().first();
        const text = await first.innerText();
        check(
          "the model half names the technology that changed",
          (await first.getAttribute("data-kind")) !== null,
          await first.getAttribute("data-name"),
        );
        check(
          "and the parameter, with both values",
          text.includes("flow_cap_max") && text.includes("12345"),
        );
      }
    }

    // ── A technology that did not exist before ──────────────────────────
    const nodes = await files.read(NODES);
    const attached = nodes.replace(
      /^(\s+)battery:$/m,
      (line, indent) => `${line}\n${indent}compare_check_wind:`,
    );
    if (attached === nodes) {
      skip("could not attach a technology to a node in this model");
    } else {
      await files.write(TECHS, `${await files.read(TECHS)}${ADDED}`);
      await files.write(NODES, attached);
      await calls.settle(() => testId("compare-refresh").click(), { expect: 1 });

      const added = page.locator(
        '[data-testid="compare-entity"][data-name="compare_check_wind"]',
      );
      const listed = await until(async () => (await added.count()) === 1, {
        timeout: 180000,
        interval: 500,
      });
      if (!listed) {
        check("an added technology is reported", false, "never appeared");
      } else {
        check("an added technology is reported", true);
        const text = await added.innerText();
        check(
          "and says what it is, rather than only that it is new",
          (await added.getAttribute("data-status")) === "added" &&
            text.includes("base_tech") &&
            text.includes("supply") &&
            text.includes("25000"),
        );
        // Its rows are a listing, so the value stands alone: an arrow would
        // invite the question of what it was before, which is nothing.
        check("and states where it is defined", text.includes("nodes"));
      }
    }

    // ── Two scenarios of one model ──────────────────────────────────────
    if ((await testId("compare-scenarios").count()) === 0) {
      skip("this model defines no scenarios or overrides");
    } else {
      await goSection("Runs");
      await testId("compare-scenarios").click();
      await testId("compare-tab").waitFor({ timeout: 20000 });

      const picker = testId("compare-scenario-b");
      await picker.click();
      const option = page.locator('[role="option"]').nth(1);
      const name = (await option.innerText()).trim();
      await option.click();

      await until(async () => page.url().includes("compare"), { timeout: 10000 });
      check(`a scenario can be chosen for one side (${name})`, true);

      await testId("compare-subtab-files").click();
      await testId("compare-files-empty").waitFor({ timeout: 20000 });
      const message = await testId("compare-files-empty").innerText();
      check(
        "two scenarios of one model read the same files",
        message.toLowerCase().includes("same files"),
      );

      // An *answer*, which for a scenario may legitimately be Calliope
      // refusing it: `cold_fusion` alone raises `KeyError: cost_dim_setter` in
      // Calliope itself, and this model's scenarios compose it. Surfacing that
      // is the correct behaviour, so the check is that the half resolves to
      // something the user can act on rather than sitting empty for ever.
      await testId("compare-subtab-model").click();
      const answered = await until(
        async () =>
          (await entities().count()) > 0 ||
          (await page.locator('[data-testid="compare-config"]').count()) > 0 ||
          (await testId("compare-model-empty").count()) > 0 ||
          (await testId("compare-model-status").count()) > 0,
        { timeout: 180000, interval: 500 },
      );
      check("and the model half answers for them", answered === true);

      const before = await testId("compare-side-a").count();
      await testId("compare-swap").click();
      check(
        "the two sides can be swapped",
        (await testId("compare-side-a").count()) === before,
      );
    }
  } finally {
    await restore();
    if (runId) {
      await goSection("Runs");
      const mine = page.locator(`[data-run-id="${runId}"]`);
      await mine.locator('[data-testid="run-menu"]').click();
      await testId("run-delete").click();
      await testId("confirm-dialog").waitFor({ timeout: 10000 });
      await testId("confirm-accept").click();
      await until(async () => (await mine.count()) === 0, { timeout: 20000 });
    }
  }
}

await outcome.guard(browser, consoleErrors, run);
