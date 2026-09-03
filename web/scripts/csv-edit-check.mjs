/**
 * An edited CSV cell must reach the file — once.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run csv-edit-check http://127.0.0.1:8791
 *
 * The dual of `save-check`, whose property is "a no-op save must not change the
 * file". ag-grid-vue3 deep-clones `rowData` before handing it to the grid, so
 * edits are committed into the grid's own copies and only the colDef
 * valueSetter carries them back to what `toRows()` serialises — a boundary the
 * unit tests exercise with hand-made clones, and one where a lost edit looks
 * exactly like a clean save. Only a real grid can drive it whole.
 *
 * Four scenarios, each a distinct way an edit can miss the file: a committed
 * edit through the embedded grid; Cmd+S with the cell editor still open (the
 * save must commit it, not skip it); an edit made under a sort, where display
 * position and file position disagree; and the standalone CSV file tab, which
 * shares the composable but owns its own save.
 *
 * The file is restored byte-for-byte in `finally`: the CI server is shared, and
 * `save-check` asserts this very file's byte identity.
 */
import { health, open, requireMode, trackRequests, results, until } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";

const TABLE = "time_varying_parameters";
const TABLE_CSV = "data_tables/time_varying_params.csv";

const { check, finish } = results("csv-edit");

const payload = requireMode(await health(BASE), "workspace", BASE);
const ws = payload.workspace_id;

const filesUrl = `${BASE}/api/versions/${ws}/files/${TABLE_CSV}`;
const read = async () => (await (await fetch(filesUrl)).json()).content;

const { browser, page, testId, consoleErrors, stable } = await open();

const calls = trackRequests(page, (request) => request.url().includes("/api/"));

const csvWrites = [];
page.on("request", (request) => {
  if (request.method() === "PUT" && request.url().includes("/csv/")) {
    csvWrites.push(request.url());
  }
});

const dirtyDot = () =>
  page.locator('[data-testid^="tab-"][data-active] [data-testid="tab-dirty"]').count();

// `.ag-cell` never matches a header cell (those are `.ag-header-cell`), so the
// row-index/col-id pair is unambiguous without naming a row container — whose
// class names are grid internals that move between majors.
const cell = (row, col) =>
  page.locator(
    `[data-testid="csv-grid"] .ag-row[row-index="${row}"] .ag-cell[col-id="${col}"]`,
  );

/**
 * Types a value into a cell. A single printable key on a focused cell starts
 * the edit replacing its content, so no select-all dance is needed.
 */
async function typeInto(locator, value) {
  await locator.click();
  await page.keyboard.type(value);
}

const save = () => calls.settle(() => testId("save").click(), { timeout: 30000 });

console.log(`CSV cell edits at ${BASE}`);
const original = await read();

try {
  await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
  await testId("model-tree").waitFor({ timeout: 20000 });
  await calls.idle();

  // ── the embedded grid, on the data-table entry tab ─────────────────────────
  const dataTables = page.getByRole("treeitem", { name: /^data tables$/i }).first();
  await calls.settle(() => dataTables.click(), { expect: 0 });
  const entry = page.getByRole("treeitem", { name: new RegExp(`^${TABLE}$`) }).first();
  if ((await entry.count()) === 0) {
    await dataTables.press("ArrowRight");
    await entry.waitFor({ timeout: 20000 });
  }
  await calls.settle(() => entry.click());
  await page.locator('[data-testid="csv-grid"] .ag-row').first().waitFor({ timeout: 30000 });
  await calls.idle();

  // A. Commit with Enter, save with the button.
  await typeInto(cell(2, "c1"), "111.25");
  await page.keyboard.press("Enter");
  check("an edit marks the tab dirty", (await until(async () => (await dirtyDot()) === 1)));

  await save();
  check("the committed edit reaches the file", (await read()).includes("111.25"));
  check("the save wrote the CSV exactly once", csvWrites.length === 1, csvWrites.join(" "));
  check("the tab is clean after saving", (await dirtyDot()) === 0);

  // A second, untouched save must write nothing — the no-op property holds
  // *after* an edit-save cycle too, not only on a freshly opened grid.
  const settled = await read();
  await calls.settle(() => testId("save").click(), { expect: 0 });
  check("an untouched save after the edit writes nothing", csvWrites.length === 1);
  check("…and the file is untouched", (await read()) === settled);

  // B. Cmd+S with the cell editor still open: the save must commit the
  // in-flight value, not skip the write because nothing was committed yet.
  await typeInto(cell(3, "c1"), "222.5");
  await calls.settle(() => page.keyboard.press("ControlOrMeta+s"), { timeout: 30000 });
  check("Cmd+S mid-edit commits and persists the value", (await read()).includes("222.5"));

  // C. Edit under a sort, where display position and file position disagree —
  // an implementation keyed on display position would write the edit into
  // whichever row the sort left at the top. The keys are read off the grid
  // rather than assumed, so the check does not depend on this file's rows.
  const unsortedKey = await cell(0, "c0").innerText();
  const header = page.locator('[data-testid="csv-grid"] .ag-header-cell[col-id="c0"]');
  await header.click();
  await header.click(); // asc, then desc
  await until(async () => (await cell(0, "c0").innerText()) !== unsortedKey);
  // The top cell's text changes at the *start* of AG Grid's row animation, not
  // the end: for a few hundred milliseconds the rendered rows are the old set
  // sliding out over the new one, and a click aimed at row 0 lands on whichever
  // row is passing through. Wait for the row set to stop changing instead.
  await stable(() =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="csv-grid"] .ag-row')).map(
        (row) => `${row.getAttribute("row-index")}@${Math.round(row.getBoundingClientRect().top)}`,
      ),
    ),
  );
  const sortedKey = await cell(0, "c0").innerText();
  check("the sort moved a different row to the top", sortedKey !== unsortedKey);

  await typeInto(cell(0, "c2"), "333.75");
  await page.keyboard.press("Enter");
  await save();
  const afterSorted = await read();
  const line = (text, key) => text.split("\n").find((l) => l.startsWith(`${key},`)) ?? "";
  check(
    "a sorted edit lands on the row's own file line",
    line(afterSorted, sortedKey).includes("333.75"),
    `top row: ${sortedKey}`,
  );
  check(
    "…and not on the line at its display position",
    !line(afterSorted, unsortedKey).includes("333.75"),
  );

  // ── the standalone CSV file tab ────────────────────────────────────────────
  await page.getByRole("link", { name: "Files" }).click();
  await testId("file-tree").waitFor({ timeout: 20000 });
  await testId("file-search").fill("time_varying_params.csv");
  await calls.settle(() =>
    page
      .locator('[data-testid="file-tree"] [role="treeitem"]', {
        hasText: "time_varying_params.csv",
      })
      .first()
      .click(),
  );
  await page.locator('[data-testid="csv-grid"] .ag-row').first().waitFor({ timeout: 30000 });
  await calls.idle();

  const writesBefore = csvWrites.length;
  await typeInto(cell(4, "c1"), "444.125");
  await page.keyboard.press("Enter");
  await save();
  check("the file tab's edit reaches the file", (await read()).includes("444.125"));
  check("…in exactly one write", csvWrites.length === writesBefore + 1);

  await calls.settle(() => testId("save").click(), { expect: 0 });
  check("an untouched file-tab save writes nothing", csvWrites.length === writesBefore + 1);

  check("no save error was shown", (await testId("save-error").count()) === 0);
  check("no console errors throughout", consoleErrors.length === 0);
} finally {
  // The server is shared with the checks that run after this one, and
  // `save-check` asserts this very file's byte identity.
  await fetch(filesUrl, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: original }),
  });
  check("teardown restored the file byte-for-byte", (await read()) === original);
}

await finish(browser, consoleErrors);
