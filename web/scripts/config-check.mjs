/**
 * The config form shows every option the model sets, and writes each one back
 * unchanged.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run config-check http://127.0.0.1:8791
 *
 * Three failures, none of them visible without a rendered form, and all three
 * from one real report: `examples/model_assignment-2026` sets
 * `calliope_version`, `math_paths`, `extra_math`, `datetime_format` and
 * `shadow_prices`, and the form displayed none of them.
 *
 * **An option can be missing from the form altogether.** `hidden: true` in the
 * overlay meant both "not part of this form" and "less commonly used", so
 * nineteen of Calliope's twenty-six config options were unreachable whatever
 * the model said. The rule now is that an option the model *sets* is always
 * shown and only an unset one can sit behind the disclosure — a statement about
 * a rendered form, so it is asserted on one.
 *
 * **A list-valued option can be written back as a string.** `shadow_prices` and
 * `extra_math` are `type: array` with no scalar variant; before the fix they
 * rendered into a plain text field as `a, b` and wrote back the *string*
 * `"a, b"`. That type-checks, saves cleanly, reports nothing, and leaves behind
 * a model Calliope will not load. `solver_options` is an object with no
 * `properties` and rendered as an empty box that could never emit at all. So
 * the check writes one of every shape into the model, presses Save without
 * touching anything, and asserts the file did not move — `save-check`'s own
 * notion of unchanged, because that is the property the editors live or die by.
 *
 * **A disclosure can open more than the section it sits in.** Its open state
 * was one flag shared by `init`, `build` and `solve`, so clicking any of the
 * three expanded all three. Nothing throws and the fields are all correct; it
 * simply reads as a broken control, which only a rendered form shows.
 *
 * `example-model` is `national_scale`, which sets almost none of this, so every
 * value here is one this check put there. The `config:` section goes back
 * exactly as it was found in the `finally` — `map-edit`'s pattern, and
 * load-bearing for the same reason: a half-finished run must not leave a model
 * carrying a solver option nobody chose.
 */
import { parse } from "yaml";

import { api, health, MOD, open, requireMode, results, trackRequests, until } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";

/** A key Calliope's schema does not describe, and will refuse to load. */
const BOGUS_KEY = "check_bogus_key";

const { check, finish } = results("config");

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

const putSection = (data) =>
  api(`${BASE}/api/versions/${ws}/yaml-section/model.yaml?section=config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data }),
  });

/** The file as found, restored verbatim on the way out. */
const original = await readFile("model.yaml");
const found = parse(original).config ?? {};

/**
 * One of every shape the scaffolded model lacks.
 *
 * `solver_options` carries a number *and* a string that looks like one, which is
 * the pair that catches an over-eager type inference: editing either row must
 * not turn `"04"` into `4`.
 */
const AUGMENTED = {
  init: {
    ...(found.init ?? {}),
    datetime_format: "%Y-%m-%d %H:%M:%S+00:00",
    resample: { timesteps: "6h" },
    [BOGUS_KEY]: "nonsense",
  },
  build: {
    ...(found.build ?? {}),
    operate: { window: "24h", horizon: "48h" },
  },
  solve: {
    ...(found.solve ?? {}),
    shadow_prices: ["system_balance"],
    solver_options: { threads: 4, mip_start: "04" },
  },
};

const { browser, page, testId, consoleErrors } = await open();
const calls = trackRequests(page, (request) => request.url().includes("/api/"));

// Through the shortcut, not the button: Save is disabled while the form is
// clean, and pressing it on an untouched form is the whole point of this check.
const save = () => calls.settle(() => page.keyboard.press(`${MOD}+s`), { timeout: 30000 });

const isDirty = async () =>
  (await page
    .locator('[data-testid^="tab-"][data-active] [data-testid="tab-dirty"]')
    .count()) > 0;

/** Every label the form is currently showing. */
const labels = () => page.locator("label").allInnerTexts();

/** Opens the config section, permanently — a previewed tab closes on the next click. */
async function openConfig() {
  await calls.settle(() =>
    page.getByRole("treeitem", { name: /^config$/i }).first().dblclick(),
  );
  await testId("save").waitFor({ timeout: 20000 });
  await calls.idle();
}

try {
  console.log(`Config at ${BASE}`);
  await putSection(AUGMENTED);

  const before = await readFile("model.yaml");

  await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
  await testId("model-tree").waitFor({ timeout: 20000 });
  await calls.idle();
  await openConfig();

  check("opening does not mark the tab dirty", !(await isDirty()));

  // ── Everything the model sets is on screen, disclosure closed ────────────
  const shown = await labels();
  for (const key of ["datetime_format", "shadow_prices", "name", "solver"]) {
    check(`${key} is shown without opening advanced`, shown.includes(key), shown.join(","));
  }
  // The mappings render as rows rather than a bordered box with nothing in it,
  // which is what `solver_options` was before the object rule was fixed.
  for (const key of ["threads", "mip_start", "timesteps"]) {
    check(
      `${key} has an editable row`,
      (await page.locator(`input[value="${key}"]`).count()) > 0,
    );
  }

  // ── The disclosure reveals the rest, and writing is not one of its jobs ──
  const advanced = page.getByRole("button", { name: /advanced/i });
  check("each section has its own advanced disclosure", (await advanced.count()) === 3);
  await advanced.first().click();
  check(
    "opening it reveals a field the model does not set",
    await until(async () => (await labels()).includes("date_format")),
  );
  // A disclosure governs the section it sits in. One flag for all three read as
  // a bug however it was justified: clicking init's opened build's and solve's.
  const opened = await labels();
  check("…only in that section", !opened.includes("objective"), opened.join(","));
  check("…and not in the one below it", !opened.includes("solver_io"));
  check("…and does not mark the tab dirty", !(await isDirty()));

  // ── The property everything else depends on ─────────────────────────────
  await save();
  const after = await readFile("model.yaml");

  const comments = (text) =>
    text.split("\n").map((line) => line.split("#")[1]?.trim()).filter(Boolean);
  const lost = comments(before).filter((c) => !comments(after).includes(c));
  check("a no-op save keeps every comment", lost.length === 0, lost.slice(0, 3).join(" | "));
  check(
    "…and the line count",
    before.split("\n").length === after.split("\n").length,
    `${before.split("\n").length} → ${after.split("\n").length}`,
  );
  // The assertion that would have caught the array written as a string and the
  // string-that-looks-like-a-number written as a number.
  check(
    "…and every value, unchanged",
    JSON.stringify(parse(before)) === JSON.stringify(parse(after)),
    JSON.stringify(parse(after).config),
  );

  // ── An unrecognised key is visible, and removable ───────────────────────
  check(
    "a key Calliope does not know is shown as unrecognised",
    (await page.locator("label").filter({ hasText: BOGUS_KEY }).count()) > 0,
  );

  await calls.settle(() =>
    page.getByRole("button", { name: "Remove this key" }).first().click(),
  );
  await save();
  const pruned = parse(await readFile("model.yaml")).config;
  check("removing it deletes that key", pruned.init[BOGUS_KEY] === undefined);
  // It is one key of many in that section, and the neighbours are the point.
  check(
    "…and only that key",
    pruned.init.datetime_format === AUGMENTED.init.datetime_format &&
      JSON.stringify(pruned.solve.shadow_prices) === '["system_balance"]' &&
      pruned.solve.solver_options.mip_start === "04",
    JSON.stringify(pruned),
  );

  check("no console errors throughout", consoleErrors.length === 0);
} finally {
  // Verbatim, comments included — the section endpoint would rewrite the file.
  await writeFile("model.yaml", original);
}

await finish(browser, consoleErrors);
