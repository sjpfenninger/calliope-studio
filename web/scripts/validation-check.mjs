/**
 * Validation, end to end: run it, read it, go to the problem, cancel it.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run validation-check http://127.0.0.1:8791
 *
 * Nothing touched this surface before. Validation is one action over two tiers —
 * a millisecond YAML parse, escalating to a Calliope build that takes seconds to
 * minutes in a subprocess — reported into a tab, with a cancel that has to kill a
 * process group and a generation counter that has to stop a poll from the run
 * that was cancelled reporting into the run that replaced it. None of that is
 * visible to a type-check, and only a browser can say whether clicking a problem
 * lands the cursor on the line it names.
 *
 * The four things pinned here, in order of how quietly each fails:
 *
 *  - **A broken parse must not escalate.** A file that will not parse also fails
 *    `read_yaml`, with a worse message and no line number, so the syntax tier is
 *    the whole answer and starting a subprocess for it is seconds spent to say
 *    something less useful. Every row carrying `data-tier="syntax"` is what says
 *    it stopped.
 *  - **The count reaches the sidebar.** The badge is visible from every section
 *    precisely so a problem is not hidden behind the section you are not looking
 *    at, and it is derived from the same list — so a badge that disagrees with
 *    the tab means one of them is stale.
 *  - **A problem navigates to itself.** As a *preview* tab, so working down a
 *    list of twelve reuses one editor rather than opening twelve, and the second
 *    click on the same row must not open a second tab.
 *  - **A cancelled generation reports nothing afterwards.** The poll it left in
 *    flight resolves after the cancel, and if it is not stamped it writes its
 *    problems into a validation the user has already stopped. That is the
 *    failure the `quiet` below is for: there is no event for "nothing happened".
 *
 * The injected error is `broken: value: here` rather than an unclosed flow
 * sequence. Both are unparsable, but ruamel marks the unclosed one at the
 * *stream end* — one line past the end of the file — which is a line Monaco
 * cannot reveal and this check could not then assert on. A second colon is
 * marked on its own line, which is the line the user is sent to.
 *
 * Writes `model.yaml` and puts it back, whatever happens.
 */
import { baseFrom, openWorkspace, quiet, results, until } from "./harness.mjs";

const BASE = baseFrom(process.argv);

// `guard` reads `this`, so it is called on the object rather than destructured
// out of it; `check` and `skip` are free functions.
const outcome = results("validation");
const { check, skip } = outcome;
const { browser, page, testId, consoleErrors, calls, enter, goSection, files } =
  await openWorkspace(BASE);

/** An unparsable line, and what the parser will say about it. */
const BROKEN = "broken: value: here";

const problems = () => page.locator('[data-testid="validation-problem"]');
const fileTabs = () => page.locator('[data-testid="tab-file"]');
const status = () => testId("validation-status").innerText();

/** The line Monaco's gutter says the cursor is on, as a number. */
const cursorLine = async () => {
  const active = page.locator(".monaco-editor .line-numbers.active-line-number").first();
  const text = (await active.textContent().catch(() => null)) ?? "";
  return Number.parseInt(text.trim(), 10);
};

console.log(`Validation at ${BASE}`);

async function run() {
  const restore = await files.guard("model.yaml");
  try {
    const original = await files.read("model.yaml");
    // Appended, so the line is arithmetic rather than a guess about the file's
    // shape: whatever is in `model.yaml`, the broken line is the one after the
    // last one that ends in a newline.
    const body = original.endsWith("\n") ? original : `${original}\n`;
    const brokenLine = body.split("\n").length;
    await files.write("model.yaml", `${body}${BROKEN}\n`);

    await enter();
    await goSection("Model");
    await testId("model-tree").waitFor({ timeout: 20000 });

    // ── the syntax tier reports, and stops ──────────────────────────────────
    await calls.settle(() => testId("validate").click());
    await testId("validation-tab").waitFor({ timeout: 30000 });
    check("validating opens the validation tab", true);
    check("and the URL names it", page.url().includes("tab=validation"));

    await until(async () => (await problems().count()) > 0, { timeout: 60000 });
    const found = await problems().count();
    check("the broken file is reported", found > 0, `${found} problems`);

    const tiers = await problems().evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-tier")),
    );
    check(
      "a file that will not parse never reaches the build tier",
      tiers.length > 0 && tiers.every((tier) => tier === "syntax"),
      tiers.join(", "),
    );
    check(
      "the status line counts what the list shows",
      (await status()).includes(String(found)),
      await status(),
    );

    const badge = testId("nav-model-badge");
    check(
      "the sidebar badge agrees with it",
      (await badge.count()) > 0 && (await badge.innerText()).trim() === String(found),
    );

    const first = problems().first();
    check(
      "the first problem names the file and the line",
      (await first.getAttribute("data-file")) === "model.yaml" &&
        Number(await first.getAttribute("data-line")) === brokenLine,
      `${await first.getAttribute("data-file")}:${await first.getAttribute("data-line")}`,
    );

    // ── clicking a problem goes there ───────────────────────────────────────
    const tabsBefore = await fileTabs().count();
    await calls.settle(() => first.click(), { grace: 3000 });
    await page.locator(".monaco-editor").first().waitFor({ timeout: 30000 });
    await until(async () => (await cursorLine()) === brokenLine, { timeout: 15000 });
    check(
      "the editor lands on the line the problem names",
      (await cursorLine()) === brokenLine,
      `gutter says ${await cursorLine()}, expected ${brokenLine}`,
    );
    check(
      "the file opens as a preview",
      (await page.locator('[data-testid="tab-file"][data-preview]').count()) === 1,
    );

    await testId("tab-validation").click();
    await problems().first().waitFor({ timeout: 10000 });
    await calls.settle(() => problems().first().click(), { expect: 0, grace: 500 });
    check(
      "working down the list reuses one editor tab",
      (await fileTabs().count()) === tabsBefore + 1,
      `${await fileTabs().count()} file tabs`,
    );

    // ── the build tier, and cancelling it ───────────────────────────────────
    await files.write("model.yaml", original);
    await testId("tab-validation").click();
    await testId("validation-revalidate").click();

    const reachedBuild = await until(
      async () => (await status()).includes("Calliope"),
      { timeout: 30000, interval: 100 },
    );
    if (!reachedBuild) {
      skip("the clean parse escalates to a Calliope build (it finished too fast)");
    } else {
      check("a clean parse escalates to a Calliope build", true);
      await testId("validation-cancel").click();
      await testId("validation-revalidate").waitFor({ timeout: 15000 });
      check("cancelling gives the Validate button back", true);
      await until(async () => (await status()).includes("Not yet validated"), {
        timeout: 10000,
      });
      check("and the status forgets the run it stopped", true);

      // The poll the cancelled generation left in flight resolves about now.
      // There is no event for it not arriving, which is what this waits out.
      await quiet(1500);
      check(
        "nothing from the cancelled generation lands afterwards",
        (await status()).includes("Not yet validated") &&
          (await problems().count()) === 0,
        await status(),
      );
    }

    // ── and once through, cleanly ───────────────────────────────────────────
    await testId("validation-revalidate").click();
    await until(async () => (await status()).includes("No problems found"), {
      timeout: 300000,
      interval: 250,
    });
    check("the restored model validates clean", true);
    check(
      "and says when it was last checked",
      (await testId("validation-tab").innerText()).includes("at "),
    );
    check(
      "the sidebar badge is gone",
      (await testId("nav-model-badge").count()) === 0,
    );
  } finally {
    await restore();
  }
}

await outcome.guard(browser, consoleErrors, run);
