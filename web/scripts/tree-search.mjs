/**
 * The filter above each explorer tree.
 *
 * A browser check rather than a vitest because the interesting half is not the
 * pruning — that is pure and tested in `lib/treeFilter.test.ts` — but the
 * handover of Reka's `expanded` model between two sets. A search opens whatever
 * hides its matches, the user's own expansion has to come back untouched when
 * the query goes, and both live inside a `TreeRoot` that also expands on click.
 * Nothing about that is observable without a rendered tree.
 *
 * The other thing only a browser shows: that typing into the field does not
 * reach `TreeRoot`'s typeahead, which would move the selection on every letter.
 */
import { health, open, requireMode, results, trackRequests } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";

const { check, finish } = results("tree-search");
const payload = requireMode(await health(BASE), "workspace", BASE);
const { browser, page, testId, consoleErrors, until } = await open();

const calls = trackRequests(page, (request) => request.url().includes("/api/"));

/** A row by its exact label. A collapsed branch renders none of its children. */
const row = (name) => page.getByRole("treeitem", { name: new RegExp(`^${name}$`, "i") });
const shown = async (name) => (await row(name).count()) > 0;

/** Types, then waits for the tree to agree, since a keystroke issues no request. */
async function filter(field, text, settled) {
  await testId(field).fill(text);
  await until(settled, { timeout: 5000 }).catch(() => {});
}

console.log(`Tree search at ${BASE}`);
await page.goto(`${BASE}${payload.landing}`, { waitUntil: "domcontentloaded" });
await testId("model-tree").waitFor({ timeout: 20000 });
await calls.idle();

// --- the model tree ---------------------------------------------------------

check("the model filter is there", await testId("model-search").isVisible());

// Expansion the user made by hand, which the search must give back.
await calls.settle(() => row("Nodes").click(), { expect: 0 });
await until(() => shown("region1"), { timeout: 5000 });
check("a branch opens on click", await shown("region1"));

await filter("model-search", "ccgt", () => shown("ccgt"));
check("a match is revealed without expanding anything", await shown("ccgt"));
check("its siblings are gone", !(await shown("csp")));
check("so is everything under another section", !(await shown("region1")));
check("and the section that holds it stays", await shown("Techs"));

// Typing must not reach TreeRoot's typeahead, which would select as it goes.
check(
  "typing did not move the selection",
  (await page.locator('[role="treeitem"][data-selected]').count()) <= 1,
);

// Collapsing and reopening a branch mid-search: the chevrons have to keep
// working, and this is the only path that writes to the expansion while a query
// is live — which is where the user's own set gets destroyed if the two are not
// kept apart. Everything below about "the expansion from before" is blind
// without it.
await calls.settle(() => row("Techs").click(), { expect: 0 });
await until(async () => !(await shown("ccgt")), { timeout: 5000 }).catch(() => {});
check("a branch can still be collapsed while filtering", !(await shown("ccgt")));
await calls.settle(() => row("Techs").click(), { expect: 0 });
await until(() => shown("ccgt"), { timeout: 5000 });
check("and reopened", await shown("ccgt"));

await calls.settle(() => row("ccgt").click(), { timeout: 30000 });

await testId("model-search").press("Escape");
await until(async () => (await testId("model-search").inputValue()) === "", {
  timeout: 5000,
});
check("Escape clears the field", (await testId("model-search").inputValue()) === "");
check("the expansion from before the search is back", await shown("region1"));
// Without this the row the user just opened from a search result is hidden
// again, under branches nobody ever expanded.
check("the row chosen from the results is still on screen", await shown("ccgt"));

await filter("model-search", "techs", () => shown("Techs"));
check("a matching section keeps its entries", await shown("battery"));
check("and drops the sections that do not match", !(await shown("Nodes")));

await page.getByRole("button", { name: "Clear the filter" }).click();
await until(async () => (await testId("model-search").inputValue()) === "", {
  timeout: 5000,
});
check("the clear button empties it too", await shown("Nodes"));

await filter("model-search", "no such component", async () => !(await shown("Techs")));
check("nothing matching says so", await page.getByText(/Nothing in the model/).isVisible());
check("and leaves the tree mounted", await testId("model-tree").isVisible());
await page.getByRole("button", { name: "Clear the filter" }).click();

// --- the file tree ----------------------------------------------------------

await calls.settle(() => page.getByRole("link", { name: "Files" }).click());
await testId("file-tree").waitFor({ timeout: 20000 });

check("the file filter is there", await testId("file-search").isVisible());

// Expand-all, which is the point of the toolbar: a workspace this size is
// entirely readable at once.
check("nothing is open to begin with", !(await shown("techs.yaml")));
await calls.settle(() => testId("toggle-folders").click(), { expect: 0 });
await until(() => shown("techs.yaml"), { timeout: 5000 });
check("expand all opens every folder", await shown("costs.csv"));
check(
  "and the button now offers the other direction",
  (await testId("toggle-folders").textContent())?.includes("Collapse"),
);
await calls.settle(() => testId("toggle-folders").click(), { expect: 0 });
await until(async () => !(await shown("techs.yaml")), { timeout: 5000 });
check("collapse all closes them again", !(await shown("costs.csv")));

await filter("file-search", "model_config/", () => shown("techs.yaml"));
check("a path narrows the file tree", await shown("locations.yaml"));
check("the directory above it is kept", await shown("model_config"));
check("a file outside it is dropped", !(await shown("model.yaml")));

await filter("file-search", "data_tables", () => shown("data_tables"));
check("a matching directory brings its contents", await shown("costs.csv"));

// The two fields are independent, and going back must not have lost either.
await page.getByRole("button", { name: "Clear the filter" }).click();
await calls.settle(() => page.getByRole("link", { name: "Model" }).click());
await testId("model-tree").waitFor({ timeout: 20000 });
check("the model tree kept its expansion across the round trip", await shown("region1"));

check(`no console errors (${consoleErrors.length})`, consoleErrors.length === 0);
await finish(browser, consoleErrors);
