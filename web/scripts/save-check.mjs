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
import { parse } from "yaml";

import { health, open, requireMode, results } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";

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

const { check, finish } = results();

const comments = (text) =>
  text
    .split("\n")
    .map((line) => line.split("#")[1]?.trim())
    .filter(Boolean);

const payload = requireMode(await health(BASE), "workspace", BASE);
const ws = payload.workspace_id;

const read = async (path) =>
  (await (await fetch(`${BASE}/api/versions/${ws}/files/${path}`)).json()).content;

const { browser, page, testId, consoleErrors } = await open();

// A save that has nothing to write must not write. Watched rather than inferred
// from the file, because `serialize_csv` round-trips most files unchanged and a
// spurious PUT would otherwise pass unnoticed until it met one that it does not.
const csvWrites = [];
page.on("request", (request) => {
  if (request.method() === "PUT" && request.url().includes("/csv/")) {
    csvWrites.push(request.url());
  }
});

console.log(`No-op save at ${BASE}`);
await page.goto(`${BASE}${payload.landing}`, { waitUntil: "networkidle" });
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

// ---------------------------------------------------------------------------
// One data table: only that table, and its CSV, saved together.
// ---------------------------------------------------------------------------

const TABLE = "time_varying_parameters";
const TABLE_CSV = "data_tables/time_varying_params.csv";

const yamlBefore = await read("model.yaml");
const csvBefore = await read(TABLE_CSV);

const dataTables = page.getByRole("treeitem", { name: /^data tables$/i }).first();
await dataTables.click();
await page.waitForTimeout(1000);

const entry = page.getByRole("treeitem", { name: new RegExp(`^${TABLE}$`) }).first();
if ((await entry.count()) === 0) {
  await dataTables.press("ArrowRight");
  await page.waitForTimeout(500);
}
await entry.click();
await page.waitForTimeout(1000);

// The grid has to have arrived before Save, or "no CSV write" is trivially true.
await testId("csv-grid").waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);

check(
  `${TABLE}: only the clicked table is shown`,
  (await page.locator('[data-testid="dt-entry"]').count()) === 1,
);
check(
  `${TABLE}: opening does not mark the tab dirty`,
  (await page.locator('[data-testid^="tab-"][data-active] .rounded-full').count()) === 0,
);

await testId("save").click();
await page.waitForTimeout(1500);

const yamlAfter = await read("model.yaml");
const csvAfter = await read(TABLE_CSV);

const lost = comments(yamlBefore).filter(
  (comment) => !comments(yamlAfter).includes(comment),
);
check(`${TABLE}: every comment in model.yaml survives`, lost.length === 0, lost[0]);
check(
  `${TABLE}: model.yaml line count is unchanged`,
  yamlBefore.split("\n").length === yamlAfter.split("\n").length,
);
check(
  `${TABLE}: model.yaml parsed content is unchanged`,
  JSON.stringify(parse(yamlBefore)) === JSON.stringify(parse(yamlAfter)),
);
// Byte identity here, unlike the YAML: the claim is that no request was made at
// all. It is also what catches the grid collapsing the three identically-named
// "Heat output…" columns of this file into one and writing the last back over
// all of them.
check(`${TABLE}: the CSV is byte-identical`, csvBefore === csvAfter);
check(
  `${TABLE}: an unedited grid issues no CSV write`,
  csvWrites.length === 0,
  csvWrites[0],
);

check("no console errors throughout", consoleErrors.length === 0);

await finish(browser, consoleErrors);
