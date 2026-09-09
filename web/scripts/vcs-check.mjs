/**
 * Version tracking, end to end: track, edit, read the diff, commit, browse.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run vcs-check http://127.0.0.1:8791
 *
 * On a throwaway model of its own. `example-model` is gitignored inside this
 * very repository — the state whose *message* is worth checking, and exactly
 * the one nothing can be committed into — so the check scaffolds a model in
 * `~/calliope-studio-vcs-check/` over the API, the way the picker does, and
 * removes both the folder and its recents entry in a `finally`. It refuses
 * to start if that folder already exists: the cleanup deletes it, so it must
 * only ever delete its own.
 *
 * What is checked, and why nothing short of a browser can:
 *
 *  - **The offer is an offer.** An untracked model shows "Track with git" and
 *    has no `.git` until the dialog is confirmed; the dialog shows the ignore
 *    file it will write. Auto-init would pass every unit test and still be
 *    the wrong feature.
 *  - **Both refresh signals, separately.** A save made in the app reaches the
 *    footer with no focus event — that is the axios interceptor, and nothing
 *    else exercises it wired up. An edit made over the API is noticed on
 *    focus — that is the terminal case. The footer count, the marker in the
 *    tree and the Changes list are three readings of one `git status`, and a
 *    stale one looks exactly like a clean tree.
 *  - **The diff editor paints.** Monaco draws to its own DOM; a pane that
 *    mounted and painted nothing looks like a file with no changes.
 *  - **A commit empties everything at once**, and the commit then reads back
 *    from History with its files, its diff, and a comparison against the
 *    current model.
 *  - **A discard puts the file back**, through the confirm dialog.
 *  - **"Commit changes first" really commits** before the run is frozen, and
 *    the run's config panel names that commit as clean.
 */
import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  api,
  baseFrom,
  health,
  MOD,
  modelFiles,
  open,
  requireMode,
  results,
  trackRequests,
  until,
} from "./harness.mjs";

const BASE = baseFrom(process.argv);

/** Where the scratch model goes. Visible, and only ever ours. */
const SCRATCH = join(homedir(), "calliope-studio-vcs-check");
const MODEL_NAME = "vcs-check-model";

/** The file edited over the API, inside a folder so the folder's count shows. */
const TECHS = "model_config/techs.yaml";

/** Monaco binds Cmd+Down on macOS where everything else uses Ctrl+End. */
const END = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

const outcome = results("vcs-check");
const { check, skip } = outcome;

const served = requireMode(await health(BASE), "workspace", BASE);

if (!served.capabilities?.vcs) {
  console.log("  skip  the server has no git to track with");
  process.exit(0);
}
if (await stat(SCRATCH).catch(() => null)) {
  console.error(`${SCRATCH} already exists; remove it and run this again.`);
  process.exit(2);
}

console.log(`Version tracking at ${BASE}`);

await mkdir(SCRATCH);
const created = await (
  await api(`${BASE}/api/projects/new/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent: SCRATCH, name: MODEL_NAME, template: "national_scale" }),
  })
).json();
const ws = created.id;
const files = modelFiles(BASE, ws);

const { browser, page, testId, consoleErrors } = await open();
const calls = trackRequests(page, (request) => request.url().includes("/api/"));

const goSection = (name) => page.getByRole("link", { name }).click();
const status = () => testId("vcs-status");
const stateOf = () => status().getAttribute("data-state");
const countText = async () =>
  (await testId("vcs-status-count").innerText().catch(() => "")).trim();
const insertions = (scope) => page.locator(`${scope} [data-testid="diff-pane"] .line-insert`);
const changeRow = (path) =>
  page.locator(`[data-testid="vcs-changes"] [data-testid="vcs-change"][data-path="${path}"]`);

/** The user going back to the window, which is how a terminal edit is noticed. */
const refocus = () =>
  calls.settle(() => page.evaluate(() => window.dispatchEvent(new Event("focus"))), {
    expect: 1,
    timeout: 20000,
  });

async function run() {
  // ── The served model first: the state this repository puts it in ─────
  await page.goto(`${BASE}${served.landing}`, { waitUntil: "domcontentloaded" });
  await testId("model-tree").waitFor({ timeout: 30000 });
  await calls.idle();
  await goSection("Files");
  await testId("vcs-panels").waitFor({ timeout: 20000 });
  const servedState = await stateOf();
  if (servedState === "ignored") {
    check(
      "a model ignored by the repository around it says so, and offers its own",
      (await testId("vcs-track").innerText()).includes("separately") &&
        (await testId("vcs-changes").innerText()).includes("ignores"),
    );
  } else {
    skip(`the served model is "${servedState}", not the ignored case`);
  }

  // ── The scratch model: untracked, then tracked ───────────────────────
  await page.goto(`${BASE}/projects/${ws}`, { waitUntil: "domcontentloaded" });
  await testId("model-tree").waitFor({ timeout: 30000 });
  await calls.idle();
  await goSection("Files");
  await testId("vcs-panels").waitFor({ timeout: 20000 });
  await until(async () => (await stateOf()) === "untracked", { timeout: 20000 });

  check(
    "a fresh model is offered tracking rather than given it",
    (await testId("vcs-track").count()) === 1 &&
      !(await stat(join(SCRATCH, MODEL_NAME, ".git")).catch(() => null)),
  );

  await testId("vcs-track").click();
  await testId("vcs-track-dialog").waitFor({ timeout: 10000 });
  check(
    "the dialog shows the ignore file it is about to write",
    (await testId("vcs-track-gitignore").innerText()).includes("*.nc"),
  );
  await calls.settle(() => testId("vcs-track-confirm").click(), { timeout: 30000 });
  await until(async () => (await stateOf()) === "ready", { timeout: 20000 });

  check("tracking lands on main", (await status().innerText()).includes("main"));
  check(
    "with nothing changed and one commit",
    (await testId("vcs-changes-empty").count()) === 1 &&
      (await testId("vcs-changes-count").innerText()).trim() === "0",
  );
  check(
    "and the ignore file on disk",
    Boolean(await stat(join(SCRATCH, MODEL_NAME, ".gitignore")).catch(() => null)),
  );

  // ── An edit made through the app ─────────────────────────────────────
  // No focus event: the response interceptor on the one axios instance is
  // what has to carry this save to the footer, and nothing else wires it.
  await page.getByText("model.yaml", { exact: true }).first().click();
  await page.locator(".monaco-editor").first().waitFor({ timeout: 30000 });
  await page
    .locator(".view-lines")
    .first()
    .locator("text=config")
    .first()
    .waitFor({ timeout: 30000 });
  await page.locator(".view-lines").first().click();
  await page.keyboard.press(END);
  await page.keyboard.type("\n# vcs-check-app\n");
  await testId("tab-dirty").first().waitFor({ timeout: 5000 });
  await calls.settle(() => page.keyboard.press(`${MOD}+s`), { timeout: 30000 });
  const noticed = await until(async () => (await countText()) === "1", { timeout: 20000 });
  check("a save made in the app reaches the footer count, with no focus event", noticed);
  check(
    "and marks the file in the tree",
    (await page.locator('[data-testid="vcs-mark"][data-state="modified"]').count()) === 1,
  );

  // ── An edit made outside the app ─────────────────────────────────────
  const original = await files.read(TECHS);
  await files.write(TECHS, `${original}\n# vcs-check\n`);
  await refocus();
  await until(async () => (await countText()) === "2", { timeout: 20000 });

  check("the footer counts an edit the app did not make", (await countText()) === "2");
  const folderCounted = await until(
    async () => (await testId("vcs-dir-count").first().innerText().catch(() => "")).trim() === "1",
    { timeout: 20000 },
  );
  check("the folder it is in counts it, folded", folderCounted);
  check("and the Changes list names it", (await changeRow(TECHS).count()) === 1);

  // ── The changes tab, from the footer ─────────────────────────────────
  await status().click();
  await testId("revision-view").waitFor({ timeout: 20000 });
  check(
    "the footer opens the changes tab",
    (await page.locator('[data-testid="tab-changes"]').count()) === 1,
  );
  await testId("diff-pane").waitFor({ timeout: 20000 });
  await until(async () => (await insertions('[data-kind="changes"]').count()) > 0, { timeout: 20000 });
  check("the diff editor paints the added line", (await insertions('[data-kind="changes"]').count()) > 0);

  // ── Committing ───────────────────────────────────────────────────────
  check("a commit needs a message", await testId("commit-button").isDisabled());
  await testId("commit-message").fill("Annotate the model");
  await calls.settle(() => testId("commit-button").click(), { timeout: 30000 });
  await until(async () => (await testId("revision-empty").count()) === 1, { timeout: 20000 });
  check("a commit empties the changes tab", (await testId("revision-empty").count()) === 1);
  check("and the footer count", (await testId("vcs-status-count").count()) === 0);
  check("and the marker", (await page.locator('[data-testid="vcs-mark"]').count()) === 0);

  // ── History, and the commit read back ────────────────────────────────
  await testId("vcs-history-toggle").click();
  const commits = page.locator('[data-testid="vcs-commit"]');
  await until(async () => (await commits.count()) === 2, { timeout: 20000 });
  check(
    "History lists the new commit first",
    (await commits.first().innerText()).includes("Annotate the model"),
  );

  await commits.first().click();
  await testId("commit-header").waitFor({ timeout: 20000 });
  await until(async () => (await testId("commit-sha").count()) === 1, { timeout: 20000 });
  check(
    "a commit opens in a tab of its own",
    (await page.locator('[data-testid="tab-commit"]').count()) === 1,
  );
  const changed = page.locator('[data-kind="commit"] [data-testid="vcs-change"]');
  await until(async () => (await changed.count()) === 2, { timeout: 20000 });
  check(
    "listing the files it changed, entry point first",
    (await changed.first().getAttribute("data-path")) === "model.yaml" &&
      (await changed.nth(1).getAttribute("data-path")) === TECHS,
  );
  await until(async () => (await insertions('[data-kind="commit"]').count()) > 0, { timeout: 20000 });
  check("with its diff painted", (await insertions('[data-kind="commit"]').count()) > 0);

  // ── The commit as a side of a comparison ─────────────────────────────
  await testId("commit-compare").click();
  await testId("compare-tab").waitFor({ timeout: 20000 });
  const named = await until(
    async () => /^Commit [0-9a-f]{7}$/.test((await testId("compare-side-a").innerText()).trim()),
    { timeout: 20000 },
  );
  check(
    "the commit can be compared with the current model",
    named && (await page.locator('[data-testid="tab-compare"]').count()) === 1,
  );

  // ── Discarding ───────────────────────────────────────────────────────
  await files.write(TECHS, original);
  await refocus();
  await until(async () => (await changeRow(TECHS).count()) === 1, { timeout: 20000 });
  await changeRow(TECHS).hover();
  await changeRow(TECHS).locator('[data-testid="vcs-discard"]').click();
  await testId("confirm-dialog").waitFor({ timeout: 10000 });
  await calls.settle(() => testId("confirm-accept").click(), { timeout: 30000 });
  await until(async () => (await testId("vcs-changes-empty").count()) === 1, { timeout: 20000 });
  check(
    "a discard puts the file back to the commit",
    (await files.read(TECHS)).includes("# vcs-check"),
  );

  // ── The run checkpoint, for real ─────────────────────────────────────
  await files.write(TECHS, `${original}\n# before the run\n`);
  await refocus();
  await until(async () => (await countText()) === "1", { timeout: 20000 });

  await goSection("Runs");
  await testId("start-run").waitFor({ timeout: 20000 });
  check(
    "a tracked model offers to commit before a run",
    (await testId("commit-before-run").count()) === 1,
  );
  await testId("commit-before-run").click();

  // Started and stopped during its build, the `compare-check` idiom: the
  // checkpoint happens before the freeze, so a cancelled run has it too.
  const rows = () => page.locator('[data-testid="run-item"]');
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
  await until(
    async () => ["cancelled", "success", "infeasible", "failed"].includes(await statusOf()),
    { timeout: 120000, interval: 200 },
  );

  await until(async () => (await testId("vcs-status-count").count()) === 0, { timeout: 20000 });
  check(
    "starting a run with the box ticked commits first",
    (await testId("vcs-status-count").count()) === 0,
  );
  await testId("run-subtab-config").click();
  await testId("run-commit").waitFor({ timeout: 20000 });
  const head = (await (await api(`${BASE}/api/versions/${ws}/vcs/`)).json()).head;
  check(
    "and the run names that commit, clean",
    (await testId("run-commit").getAttribute("data-sha")) === head &&
      (await testId("run-commit").getAttribute("data-dirty")) === "false",
  );
}

/** No trace on disk or in the recents list, whatever happened above. */
async function cleanUp() {
  await api(`${BASE}/api/projects/${ws}/`, { method: "DELETE" }).catch(() => null);
  await rm(SCRATCH, { recursive: true, force: true });
}

// `guard` exits the process on its way out, so the cleanup has to run inside
// the body rather than after it.
await outcome.guard(browser, consoleErrors, async () => {
  try {
    await run();
  } finally {
    await cleanUp();
  }
});
