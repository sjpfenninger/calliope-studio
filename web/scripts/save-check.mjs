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

check("no console errors throughout", consoleErrors.length === 0);

await finish(browser, consoleErrors);
