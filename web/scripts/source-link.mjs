/**
 * The provenance marker beside an inherited field: does it say what the source
 * is, and does it go there?
 *
 * A browser check rather than a vitest because both halves are only true once
 * rendered. The label is assembled from the component tree, which is fetched;
 * and "the click opened the right thing" is a statement about the tab bar, which
 * is the shell's state and not the component's.
 *
 * The failure it exists to catch is silent in the way `model-picker`'s is: a
 * source that fails to resolve renders as plain text, which looks like a
 * deliberate design rather than a lookup that missed, and a link that opens the
 * wrong file opens *a* file and says nothing about it being the wrong one.
 *
 * The two kinds are checked in **different editors**, because national_scale
 * puts them in different editors: only its transmission technologies inherit a
 * template's ordinary parameters, and only its technologies take parameters from
 * a data table. Asserting both in one form passes on a model that has both and
 * fails on working code everywhere else.
 *
 * Its nodes are the near miss that says why: three of them name `csp_regions`,
 * but that template supplies nothing except `techs:` — which the node form has a
 * block of its own for and therefore promotes past the ghost rows. No marker is
 * the right answer there, so the check must not look for one.
 *
 * Usage: pnpm run source-link http://127.0.0.1:8791
 */
import { open, results, health, requireMode, trackRequests } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";
const { check, finish } = results("source links");

const payload = requireMode(await health(BASE), "workspace", BASE);
const { browser, page, testId, consoleErrors } = await open();
const calls = trackRequests(page, (request) => request.url().includes("/api/"));

const links = (kind) =>
  page.locator('[data-testid="source-link"]', { hasText: `(${kind})` });

/** The active tab's title, which is how the shell says what it opened. */
const activeTab = () =>
  page.locator('[data-testid^="tab-"][data-active]').first().innerText();

/**
 * The text of the line Monaco has the cursor on.
 *
 * Read off the rendered rows rather than from the editor's API: the assertion is
 * that the user is *looking* at the declaration, and a model whose cursor is set
 * but whose viewport never scrolled would pass an API check.
 */
const cursorLine = () =>
  page.evaluate(() => {
    const current = document.querySelector(".current-line");
    if (!current) return null;
    const top = current.getBoundingClientRect().top;
    for (const row of document.querySelectorAll(".view-line")) {
      if (Math.abs(row.getBoundingClientRect().top - top) < 2) return row.textContent;
    }
    return null;
  });

/** Opens a model-tree section and waits for its editor. */
async function openSection(name) {
  await calls.settle(() =>
    page.getByRole("treeitem", { name: new RegExp(`^${name}$`, "i") }).first().click(),
  );
  await testId("save").waitFor({ timeout: 20000 });
  await calls.idle();
  // nodes and links open on the map; the fields are on the list side.
  if ((await testId("editor-map").count()) === 1) {
    await testId("view-list").click();
    await testId("editor-map")
      .waitFor({ state: "detached", timeout: 20000 })
      .catch(() => {});
  }
}

try {
  console.log(`Source links at ${BASE}`);
  await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
  await testId("model-tree").waitFor({ timeout: 20000 });
  await calls.idle();

  // ── A data table, from the techs editor ──────────────────────────────────
  await openSection("techs");

  // One place visited is no history. A pair of buttons that look live from the
  // first click says the stack is recording something the user did not do.
  check("nothing to go back to at the start", await testId("history-back").isDisabled());
  check("nothing to go forward to either", await testId("history-forward").isDisabled());

  const labels = await page.locator('[data-testid="source-link"]').allTextContents();
  check("the techs editor shows source links", labels.length > 0);

  // The whole point: a bare name cannot say which of the two kinds it is, and a
  // table may be named after the very parameter it supplies.
  check(
    "every link names its kind",
    labels.every((text) => /\((template|data_table)\)$/.test(text.trim())),
    labels.slice(0, 5).join(" | "),
  );
  check("the techs editor's sources are data tables", (await links("data_table").count()) > 0);

  // A data table opens by name in its own structured editor, so the tab is
  // titled with the table — not with the file it happens to be declared in.
  const table = (await links("data_table").first().innerText())
    .trim()
    .replace(" (data_table)", "");
  await calls.settle(() => links("data_table").first().click());
  check(`a data-table link opens ${table}`, (await activeTab()).includes(table), await activeTab());
  check(
    "…in the data-tables editor, not as raw YAML",
    (await page.locator('[data-testid="dt-entry"]').count()) === 1,
  );

  // ── A template, from the links editor ────────────────────────────────────
  await openSection("links");
  check("the links editor's sources include a template", (await links("template").count()) > 0);

  const label = (await links("template").first().innerText()).trim();
  const name = label.replace(" (template)", "");
  await calls.settle(() => links("template").first().click());
  const title = await activeTab();
  check(`a template link opens a YAML file (${label} → ${title})`, /\.ya?ml$/.test(title));

  // Monaco reveals the position, so the line under the cursor is the one that
  // declares the template. Landing at line 1 of a file of many is the failure
  // the server-side line number exists to prevent.
  const line = await cursorLine();
  check(
    `…scrolled to the line that declares ${name}`,
    line !== null && line.trim().startsWith(`${name}:`),
    `cursor line: ${JSON.stringify(line)}`,
  );

  // ── And back again ───────────────────────────────────────────────────────
  //
  // The jump above is the case back exists for, and it is worse than a dead end:
  // every click here was a plain one, so each landed in the preview slot and
  // evicted the last. The links editor's tab is not merely behind us, it was
  // *closed* by the click that opened the template. Going back therefore has to
  // rebuild it from its id, not re-select it.
  check("back is offered after a jump", await testId("history-back").isEnabled());

  await calls.settle(() => testId("history-back").click());
  check(
    "back returns to the editor the jump closed",
    (await activeTab()).toLowerCase().includes("links"),
    await activeTab(),
  );
  check(
    "…in its structured editor, rebuilt",
    (await testId("save").count()) === 1,
  );

  await calls.settle(() => testId("history-forward").click());
  check(
    "forward returns to the template file",
    /\.ya?ml$/.test(await activeTab()),
    await activeTab(),
  );

  // The reveal is one-shot — Monaco nulls `jumpTarget` once it has consumed it,
  // and stores the cursor nowhere. Without the position on the history entry
  // this comes back at line 1, which reads as forward half-working.
  const again = await cursorLine();
  check(
    `…at the line it left, still declaring ${name}`,
    again !== null && again.trim().startsWith(`${name}:`),
    `cursor line: ${JSON.stringify(again)}`,
  );

  check("no console errors", consoleErrors.length === 0, consoleErrors.join("\n"));
} finally {
  await browser.close();
}

finish();
