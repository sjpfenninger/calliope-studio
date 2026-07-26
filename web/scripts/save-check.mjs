/**
 * A no-op save must not change the file.
 *
 *   pixi run calligraph --no-browser --port 8791 example-model
 *   npm run save-check -- http://127.0.0.1:8791
 *
 * Table-driven over every structured section: open the editor, press Save
 * without touching anything, and compare the file with what it was. This is the
 * single most valuable browser check in the suite, because the editors are where
 * a bug silently corrupts a user's model — and it found three real ones the
 * first time it ran:
 *
 *   - `area_use_max: .inf` and `storage_cap_max: .inf` were deleted from
 *     techs.yaml. `.inf` cannot cross JSON, so it arrived as null, and the
 *     editors drop empty values.
 *   - the config editor rewrote `config.init.subset.timesteps` as
 *     `config.init.time_subset` — the pre-0.7 spelling, which is not in the
 *     schema at all.
 *   - the config tab acquired an unsaved-changes dot from merely being opened.
 *
 * **Not** byte identity, which is not achievable and never was: a bare ruamel
 * load→dump normalises `True`→`true`, an explicit `null` to empty, and flow
 * mapping padding — all invisible to any YAML parser, and all present in
 * Calliope's own files. The notion asserted here is the one
 * `tests/test_yaml_io.py::assert_faithful_rewrite` defines: comments, line
 * count, and parsed content.
 */
import { chromium } from "playwright-core";
import { parse } from "yaml";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";
const EXECUTABLE =
  process.env.CHROMIUM ?? "/Applications/Chromium.app/Contents/MacOS/Chromium";

/** Section in the model tree → the file it is defined in, for `example-model`. */
const SECTIONS = [
  ["techs", "model_config/techs.yaml"],
  ["links", "model_config/techs.yaml"],
  ["nodes", "model_config/locations.yaml"],
  ["config", "model.yaml"],
  ["data tables", "model.yaml"],
  ["overrides", "scenarios.yaml"],
  ["scenarios", "scenarios.yaml"],
];

const failures = [];
function check(description, condition, detail) {
  if (condition) console.log(`  ok    ${description}`);
  else {
    console.log(`  FAIL  ${description}${detail ? `\n        ${detail}` : ""}`);
    failures.push(description);
  }
}

const comments = (text) =>
  text
    .split("\n")
    .map((line) => line.split("#")[1]?.trim())
    .filter(Boolean);

const health = await (await fetch(`${BASE}/api/health`)).json();
if (health.mode !== "workspace") {
  console.error("This check needs a server opened on a model folder.");
  process.exit(2);
}
const ws = health.workspace_id;

const read = async (path) =>
  (await (await fetch(`${BASE}/api/versions/${ws}/files/${path}`)).json()).content;

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

const testId = (name) => page.locator(`[data-testid="${name}"]`);

console.log(`No-op save at ${BASE}`);
await page.goto(`${BASE}${health.landing}`, { waitUntil: "networkidle" });
await testId("model-tree").waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);

for (const [section, file] of SECTIONS) {
  const before = await read(file);

  await page
    .getByRole("treeitem", { name: new RegExp(`^${section}$`, "i") })
    .first()
    .click();
  await page.waitForTimeout(2000);

  // Opening alone must not mark the tab dirty, or the shell warns about unsaved
  // changes on the way out of a file nobody edited.
  check(
    `${section}: opening does not mark the tab dirty`,
    (await page.locator('[data-testid^="tab-"][data-active] .rounded-full').count()) ===
      0,
  );

  await testId("save").click();
  await page.waitForTimeout(1500);
  const after = await read(file);

  const lostComments = comments(before).filter(
    (comment) => !comments(after).includes(comment),
  );
  check(
    `${section}: every comment survives`,
    lostComments.length === 0,
    lostComments.slice(0, 3).join(" | "),
  );
  check(
    `${section}: the line count is unchanged`,
    before.split("\n").length === after.split("\n").length,
    `${before.split("\n").length} → ${after.split("\n").length}`,
  );
  check(
    `${section}: the parsed content is unchanged`,
    JSON.stringify(parse(before)) === JSON.stringify(parse(after)),
  );
}

check("no console errors throughout", consoleErrors.length === 0);
if (consoleErrors.length) {
  consoleErrors.slice(0, 8).forEach((line) => console.log(`        ${line}`));
}

await browser.close();
process.exit(failures.length ? 1 : 0);
