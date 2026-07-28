/**
 * The results view opens, and its filters narrow what the charts ask for.
 *
 *   pixi run calliope-studio --no-browser --port 8792 path/to/results.nc
 *   npm run smoke:results -- http://127.0.0.1:8792
 *
 * Type-checking and unit tests cannot see the things that actually broke here:
 * an Arrow reader whose schema is only on the batch, an ECharts option merge
 * that never removes a series, a map layer that silently draws nothing. Each of
 * those looked fine until a real browser rendered it.
 *
 * Every selector is a `data-testid` or a role. The previous version drove this
 * screen through the component library's own class names, and every one of them
 * died the moment those controls were rewritten — a large part of what made that
 * migration expensive, and there is no reason to re-earn it.
 */
import { results } from "./harness.mjs";
import { baseFrom, openResults } from "./results-page.mjs";

const BASE = baseFrom(process.argv);
const { check, skip, finish } = results("results");
const { browser, page, testId, consoleErrors, frames, settle, quiet } =
  await openResults(BASE);

console.log(`Results view at ${BASE}`);

check("landed in the shell", page.url().includes("tab=run"));
check("charts and map rendered", (await page.locator("canvas").count()) >= 2);
check("map mounted", (await page.locator(".maplibregl-map").count()) === 1);
check("filters rendered", (await testId("run-filters").count()) === 1);
check("no console errors on load", consoleErrors.length === 0);

// Switching to Duration changes the axis from time to category, which an
// ECharts option merge cannot absorb.
await settle(() => testId("plot-type").getByText("Duration", { exact: true }).click());
check(
  "duration order requested",
  frames.some(({ query }) => query?.order === "duration"),
);
await settle(() => testId("plot-type").getByText("Bar", { exact: true }).click());

// The technologies are split across a section per base tech — supply, storage,
// demand — plus one for the links. `data-dimension` is how the panel says which
// dataset dimension a section actually filters, and it is the only marker that
// does not depend on what a given model happens to contain.
const techSections = page.locator('[data-testid^="filter-"][data-dimension="techs"]');
const techSectionNames = await techSections.evaluateAll((nodes) =>
  nodes.map((node) => node.dataset.testid.replace("filter-", "")),
);
check("the technologies are split into sections", techSectionNames.length >= 2);
console.log(`  sections: ${techSectionNames.join(", ")}`);

// Deselecting a technology must remove its series, which merging never does.
const first = techSections.first();
const techRows = first.locator('[role="checkbox"][data-testid]');
const toggleOne = async () => {
  if (await techRows.count()) {
    await techRows.first().click();
    return;
  }
  // A section with more members than fit as checkboxes gets the searchable
  // control instead.
  await first.getByRole("combobox").click();
  await page.getByRole("option").first().click();
  await page.keyboard.press("Escape");
};
check("deselecting a technology re-queries", (await settle(toggleOne)) > 0);

// The point of the split: one click clears a whole type. `None` then `All` on a
// section must move the chart in both directions.
const cleared = await settle(() => first.getByText("None", { exact: true }).click());
check("clearing a whole type re-queries", cleared > 0);
const clearedTechs = frames.at(-1)?.query?.selectors?.techs ?? [];

const restored = await settle(() => first.getByText("All", { exact: true }).click());
check("restoring a whole type re-queries", restored > 0);
check(
  "All restores more technologies than None left",
  (frames.at(-1)?.query?.selectors?.techs ?? []).length > clearedTechs.length,
);

// Transmission links get a section of their own: on a real model they outnumber
// the technologies five to one, and an undivided list is unusable. Theirs is the
// one tech section whose members are labelled by their endpoints, and the one
// that starts de-selected — so this click turns a link *on*.
if (await testId("filter-transmission").count()) {
  const linkRows = page.locator('[data-testid^="filter-transmission-"]');
  const toggleLink = async () => {
    if (await linkRows.count()) {
      check(
        "links are named by their endpoints",
        (await linkRows.first().innerText()).includes("→"),
      );
      await linkRows.first().click();
      return;
    }
    const control = testId("filter-transmission").getByRole("combobox");
    await control.click();
    check(
      "links are named by their endpoints",
      (await page.getByRole("option").first().innerText()).includes("→"),
    );
    await page.getByRole("option").first().click();
    await page.keyboard.press("Escape");
  };
  check("toggling a link re-queries", (await settle(toggleLink)) > 0);
} else {
  skip("the transmission section (this model has no links)");
}

// None of those sections is a dimension — the dataset has no `supply` or
// `transmission` coordinate — and `filter_selectors` drops keys it does not know
// *silently*. A leak would not raise anything; the `techs` filter would just
// quietly lose most of its members.
const syntheticSections = techSectionNames.filter((name) => name !== "techs");
check(
  "no section name reaches the server as a selector key",
  frames.every(({ query }) =>
    syntheticSections.every((name) => query?.selectors?.[name] === undefined),
  ),
);

// The sub-views of a run tab. Results has to survive a trip to the log, or
// coming back would rebuild the map and refetch every frame.
if (await testId("run-subtab-log").isEnabled()) {
  await testId("run-subtab-log").click();
  await testId("run-log").waitFor({ timeout: 15000 });
  check("log sub-view opens", (await testId("run-log").count()) === 1);

  const returned = await settle(() => testId("run-subtab-results").click(), {
    expect: 0,
  });
  // Nothing to wait *for* — the assertion is that no request goes out — so this
  // is one of the few places a bounded pause is the honest instrument.
  await quiet(400);
  check("returning to results issues no new frame request", returned === 0);
  check("results pane was kept alive", (await page.locator("canvas").count()) >= 2);
} else {
  // A bare `.nc` has no run behind it, so it has no log and nothing was frozen.
  skip("run sub-views (these results have no run behind them)");
}

check("no console errors throughout", consoleErrors.length === 0);
await finish(browser, consoleErrors);
