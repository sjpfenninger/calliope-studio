/**
 * Custom math, end to end: declare a file, enable it, and read the notation.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run math-check http://127.0.0.1:8791
 *
 * A browser check rather than a vitest because **the failure it exists to catch
 * is silent and only exists once rendered**. KaTeX with `throwOnError: false`
 * turns an equation it cannot read into a marked-up error in place: nothing
 * throws, nothing is logged, and a formulation with one equation missing from
 * the middle of it looks exactly like a formulation without one. `.katex-error`
 * is the only evidence, and only a rendered page has it.
 *
 * The rest is the wire-up half, which had no interface at all before this.
 * `config.init.math_paths` registers a name against a file and
 * `config.init.extra_math` applies it — two acts, and a file that gets only the
 * first is read by nobody while Calliope says nothing, because from its point of
 * view you did not ask for it. So the check does what a user does: create the
 * file, watch it become enabled, watch its constraint appear in the rendered
 * math badged as an override of a base one, then turn it off and watch it go.
 *
 * It runs against `national_scale`, which ships **no** custom math — so every
 * assertion here is about something this check itself put there, and the model
 * goes back exactly as it was found in the `finally`. That is `map-edit`'s
 * pattern, and it is load-bearing for the same reason: a half-finished run used
 * to leave a node where it dragged it, and this one would leave a model whose
 * math does not build.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "yaml";

import { api, health, MOD, open, quiet, requireMode, results, trackRequests, until } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";

/** The math this check writes. `balance_demand` is a real base constraint. */
const MATH_NAME = "check_math";
const MATH_PATH = `${MATH_NAME}.yaml`;
const MATH_BODY = `constraints:
  balance_demand:
    description: Overridden by the math check.
    foreach: [nodes, techs, carriers, timesteps]
    where: "base_tech==demand"
    equations:
      - expression: flow_in_inc_eff >= sink_use_equals * 1
  check_only_constraint:
    description: Added by the math check.
    foreach: [nodes, techs, carriers]
    where: flow_cap_max
    equations:
      - expression: flow_cap <= flow_cap_max
`;

const { check, finish } = results("math");

const payload = requireMode(await health(BASE), "workspace", BASE);
const ws = payload.workspace_id;

const readFile = async (path) =>
  (await (await api(`${BASE}/api/versions/${ws}/files/${path}`)).json()).content;

const writeFile = (path, content) =>
  api(`${BASE}/api/versions/${ws}/files/${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });

const modelBefore = await readFile("model.yaml");

/**
 * `config.init` as the file now says it.
 *
 * Parsed rather than matched with a regex: ruamel writes `extra_math` as a block
 * list, so `extra_math: [check_math]` and a two-line sequence are the same thing
 * to every reader that matters and completely different to a line-wise pattern.
 * The first version of this check asserted the wrong one and failed on working
 * code.
 */
const initConfig = async () => parse(await readFile("model.yaml")).config.init;

const { browser, page, testId, consoleErrors } = await open();
const calls = trackRequests(page, (request) => request.url().includes("/api/"));

/**
 * Waits for a render to finish, which is a subprocess and takes seconds.
 *
 * Two waits, not one: the status reads "N components" *from the previous
 * render* the instant Render again is clicked, so a check that only waited for
 * that pattern passed immediately and then asserted against stale notation.
 * Waiting for "Rendering…" first is what makes the second wait mean anything.
 */
async function rendered({ starts = false } = {}) {
  const status = () => testId("math-status").innerText();
  if (starts && !(await until(async () => /Rendering/.test(await status()), { timeout: 20000 }))) {
    return false;
  }
  return until(async () => /\d+ components/.test(await status()), {
    timeout: 120000,
    interval: 200,
  });
}

/** Clicks the Math group in the model tree and waits for the tab. */
async function openMathTab() {
  await calls.settle(() => page.getByRole("treeitem", { name: /^math$/i }).first().click());
  await testId("math-tab").waitFor({ timeout: 20000 });
}

/**
 * Makes the Math group's sources visible in the tree.
 *
 * Clicking the group both opens the tab *and* toggles its expansion, so whether
 * the children are showing depends on how many times it has been clicked — which
 * is not something a check should be counting. This asserts the state it wants
 * instead of assuming it.
 */
async function showMathSources(name) {
  // A prefix, not an exact match: the badge beside a source is part of the row's
  // accessible name, so once one says "not enabled" its name is no longer just
  // the source name — and that is precisely the state being asserted here.
  const listed = async () =>
    (await page.getByRole("treeitem", { name: new RegExp(`^${name}\\b`) }).count()) > 0;
  if (await listed()) return true;
  await calls.settle(() => page.getByRole("treeitem", { name: /^math$/i }).first().click());
  return until(listed);
}

const componentRow = (name) => page.locator(`[data-math-component="${name}"]`);

try {
  console.log(`Math at ${BASE}`);
  await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
  await testId("model-tree").waitFor({ timeout: 20000 });
  await calls.idle();

  // Open the config editor *first*, and leave it open. It holds the whole
  // `config` section in a buffer read once on mount, and the files panel below
  // writes that same section — so a stale editor saving later would silently
  // revert the math settings. `useSectionEditor` reloads on a cache
  // invalidation, and the assertion at the end of this check is what says so.
  //
  // **Double-click, not click.** A plain click previews, and the preview slot is
  // emptied by the next permanent open — which is the Math tab, two lines below.
  // A previewed config tab would therefore be closed and reopened, mounting a
  // fresh editor with fresh data, and the assertion at the end of this check
  // would pass on exactly the code it exists to catch.
  await calls.settle(() =>
    page.getByRole("treeitem", { name: /^config$/i }).first().dblclick(),
  );
  await testId("save").waitFor({ timeout: 20000 });
  await calls.idle();

  // ── The tree says what math is in play, before anything is rendered ──────
  check(
    "the model tree has a Math group",
    (await page.getByRole("treeitem", { name: /^math$/i }).count()) === 1,
  );

  await openMathTab();
  check("clicking it opens the Math tab", (await testId("math-tab").count()) === 1);

  // ── Base math renders ────────────────────────────────────────────────────
  check("the render finishes", await rendered(), await testId("math-status").innerText());

  const listed = await page.locator("[data-math-component]").count();
  check(`the formulation is listed (${listed} components)`, listed > 20);

  await calls.settle(() => componentRow("balance_demand").click());
  await testId("math-equation").waitFor({ timeout: 20000 });

  // The whole point. KaTeX renders into spans; `.katex` present and
  // `.katex-error` absent is the difference between notation and a red string of
  // LaTeX source that nothing anywhere reports.
  check(
    "the equation is typeset",
    (await page.locator('[data-testid="math-equation"] .katex').count()) > 0,
  );
  check(
    "…with nothing KaTeX could not read",
    (await page.locator(".katex-error").count()) === 0,
  );

  // `\negthickspace` and the `\forall` line come out as real glyphs, so the
  // rendered box is much taller than one line of text. A zero-height or
  // unstyled equation is the map-at-0px failure in another costume.
  const box = await testId("math-equation").boundingBox();
  check(
    "…and takes up real space",
    Boolean(box) && box.height > 30 && box.width > 100,
    JSON.stringify(box),
  );

  check(
    "a base constraint is attributed to base",
    (await testId("math-origin").innerText()).includes("base"),
  );

  // ── Cross-references navigate in place ───────────────────────────────────
  const openTabs = await page.locator('[data-testid^="tab-"]').count();
  const reference = page.locator("[data-math-ref]:not([disabled])").first();
  const referenced = (await reference.innerText()).trim();
  await reference.click();
  check(
    `following a reference selects ${referenced}`,
    await until(async () =>
      (await testId("math-detail").innerText()).includes(referenced),
    ),
  );
  // The reason the tab id carries no source: a formulation is a graph, and
  // opening a tab per hop would make following it unusable in three clicks.
  check(
    "…in place, without opening another tab",
    (await page.locator('[data-testid^="tab-"]').count()) === openTabs,
  );

  // ── A component the model has nothing for ────────────────────────────────
  // national_scale has no conversion technology, so `balance_conversion`'s
  // `where` matches nothing and Calliope's notation for it is an empty array
  // block — which KaTeX draws as nothing, with no `.katex-error` to find. That
  // was a blank where the equation goes, indistinguishable from a render that
  // failed; the tab has to say why instead.
  await calls.settle(() => componentRow("balance_conversion").click());
  check(
    "a constraint nothing binds to says so",
    await until(async () => (await testId("math-unmatched-note").count()) === 1),
  );
  check("…and draws no empty equation", (await testId("math-equation").count()) === 0);
  check(
    "…and is badged in the list",
    (await componentRow("balance_conversion").locator('[data-testid="math-unmatched"]').count()) === 1,
  );

  // ── Now the wire-up: create a math file and enable it ────────────────────
  check("there is no custom math to begin with", (await testId("math-files").innerText()).includes("No custom math"));

  await testId("math-new-file").click();
  await testId("math-new-name").fill(MATH_NAME);
  await calls.settle(() => page.getByRole("button", { name: "Create" }).click());
  await calls.idle();

  // Creating one deliberately moves you into it — an empty math file is not the
  // end of the task — which is also why the panel is asserted on the way back
  // rather than here: the Math tab is no longer the one in front.
  check(
    "creating a math file opens it for editing",
    await until(async () =>
      (await page.locator('[data-testid^="tab-"][data-active]').first().innerText()).includes(
        MATH_PATH,
      ),
    ),
    await page.locator('[data-testid^="tab-"][data-active]').first().innerText(),
  );

  const declared = await initConfig();
  check(
    "…and registers it in math_paths",
    declared.math_paths?.[MATH_NAME] === MATH_PATH,
    JSON.stringify(declared.math_paths),
  );
  // The second act, and the one with no interface before this. Declaring without
  // enabling produces math Calliope never reads and never mentions.
  check(
    "…and enables it in extra_math",
    (declared.extra_math ?? []).includes(MATH_NAME),
    JSON.stringify(declared.extra_math),
  );

  // Write real math into it through the API rather than by typing: what is being
  // checked is that the app *notices*, not that Monaco accepts keystrokes.
  await writeFile(MATH_PATH, MATH_BODY);

  await openMathTab();
  check(
    "the files panel lists it, enabled",
    await until(async () => (await page.locator(`[data-math-file="${MATH_NAME}"]`).count()) === 1),
  );

  // The model changed under the rendering that is on screen, and saying so is
  // the alternative to silently re-rendering or silently lying.
  check(
    "the tab says the rendering is out of date",
    await until(async () => (await testId("math-tab").innerText()).includes("has changed")),
  );

  await testId("math-refresh").click();
  check("the model's own math renders", await rendered({ starts: true }));

  check(
    "a constraint from it appears",
    await until(async () => (await componentRow("check_only_constraint").count()) === 1),
  );

  // The single most important thing a custom-math author cannot see in the YAML:
  // this name was already defined, and their file replaced it.
  await calls.settle(() => componentRow("balance_demand").click());
  check(
    "a redefined base constraint is badged as an override",
    await until(async () =>
      (await testId("math-detail").innerText()).includes(`replaces base`),
    ),
    await testId("math-detail").innerText().catch(() => ""),
  );
  check(
    "…and is attributed to the file that replaced it",
    (await testId("math-origin").innerText()).includes(MATH_NAME),
  );

  // ── The filter narrows to what the user wrote ────────────────────────────
  const before = await page.locator("[data-math-component]").count();
  await testId("math-user-only").click();
  const after = await page.locator("[data-math-component]").count();
  check(`"Mine" narrows the list (${before} → ${after})`, after > 0 && after < before);
  check(
    "…to exactly the two this check wrote",
    (await componentRow("check_only_constraint").count()) === 1 &&
      (await componentRow("balance_demand").count()) === 1,
  );

  // ── The config editor must not revert what the files panel wrote ────────
  //
  // `config` has two writers — the config editor's whole-section buffer and the
  // files panel — so whichever saves second wins. It holds today because
  // `TabBody` mounts a structured editor only while its tab is *active*, so the
  // config tab above was torn down and re-read while the math was being enabled.
  // That is a property of the tab shell, not of either writer, and a switch to
  // `v-show` (which Monaco already gets) would break it silently: the user's
  // math would stop being applied on the next unrelated config save, with
  // nothing anywhere to say why. Pinned from the outside for that reason.
  await calls.settle(() =>
    page.getByRole("treeitem", { name: /^config$/i }).first().click(),
  );
  await testId("save").waitFor({ timeout: 20000 });
  // The button is disabled on a clean form; the shortcut still writes, which
  // is what keeps a no-op save testable at all.
  await calls.settle(() => page.keyboard.press(`${MOD}+s`));
  await calls.idle();

  const afterConfigSave = await initConfig();
  check(
    "saving config does not revert the math settings",
    (afterConfigSave.extra_math ?? []).includes(MATH_NAME),
    JSON.stringify({
      extra_math: afterConfigSave.extra_math,
      math_paths: afterConfigSave.math_paths,
    }),
  );

  await openMathTab();

  // ── Disabling it is the other half of the same knob ──────────────────────
  await calls.settle(() =>
    page.locator(`[data-math-file="${MATH_NAME}"] button[role="switch"]`).click(),
  );
  await calls.idle();
  const disabled = await initConfig();
  check(
    "turning it off removes it from extra_math",
    !(disabled.extra_math ?? []).includes(MATH_NAME),
    JSON.stringify(disabled.extra_math),
  );
  // Off, not gone: the file is still declared, which is exactly the state the
  // tree has to flag — and the state Remove is for.
  check(
    "…but leaves it declared in math_paths",
    disabled.math_paths?.[MATH_NAME] === MATH_PATH,
    JSON.stringify(disabled.math_paths),
  );

  // A declared file nobody enabled does nothing and Calliope never says so, so
  // the tree is the only place a user finds out.
  check("the disabled source is still listed in the tree", await showMathSources(MATH_NAME));
  check(
    "…flagged as not enabled",
    await until(async () =>
      (await testId("model-tree").innerText()).includes("not enabled"),
    ),
    await testId("model-tree").innerText(),
  );

  // ── Nothing was written to the model except through the app ─────────────
  await quiet();
} finally {
  // Whatever happened above, the model goes back as it was found: the checks
  // that run after this one expect national_scale with no custom math, and so
  // does the next attempt at this one.
  await writeFile("model.yaml", modelBefore);
  // Over the filesystem, because there is no delete verb in the files API — a
  // deliberate gap, since nothing in the app deletes a model file. `health`
  // reports the workspace path, and this only ever removes what it created.
  await rm(join(payload.workspace, MATH_PATH), { force: true });
}

check("no console errors throughout", consoleErrors.length === 0, consoleErrors[0]);

await finish(browser, consoleErrors);
