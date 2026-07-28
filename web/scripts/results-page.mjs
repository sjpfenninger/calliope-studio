/**
 * Opening the results view, which every one of the `smoke-*` checks starts with.
 *
 * The checks were one 850-line script covering the load, the filters, the
 * layouts, the map, the charts, the table, the exports and both themes. That
 * made a change to any one of them cost all of the others, and it made the
 * failure report say "smoke" rather than which of eight areas broke. They are
 * separate files now, run concurrently by `smoke.mjs` against one server — they
 * only read, and each drives its own browser context, so nothing they do can
 * reach another.
 *
 * This is the part they genuinely shared.
 */
import { health, open } from "./harness.mjs";

/** Everything the results view persists, so a check starts from a known state. */
const RESULTS_KEYS = [
  "calliope-studio.results.layout",
  "calliope-studio.results.geometry",
  // The two the layouts replaced. Left behind, they seed the stacked layout
  // through the migration, so a run would start from the *last* run's drag.
  "calliope-studio.results.split",
  "calliope-studio.results.collapsed",
  "calliope-studio.theme",
];

/**
 * Opens `/results` and waits until there is something to check.
 *
 * `/results` resolves whatever the server was opened on and replaces itself with
 * a shell URL carrying a run tab.
 *
 * The waiting is the point. This used to be `waitForTimeout(4000)`, which is
 * both a guess and the wrong shape of guess: what has to be true is that the
 * pane is up, the map has loaded its style, and the frames the first render
 * asked for have come back. All three are observable.
 */
export async function openResults(base, { viewport, keepStorage = false } = {}) {
  const harness = await open({ viewport: viewport ?? { width: 1400, height: 1100 } });
  const { page, testId, framesIdle, mapReady } = harness;

  await health(base);

  // The browser profile outlives a run, so a layout dragged by the last one
  // would otherwise decide where this one starts.
  await page.goto(base, { waitUntil: "domcontentloaded" });
  if (!keepStorage) {
    await page.evaluate((keys) => {
      for (const key of keys) localStorage.removeItem(key);
    }, RESULTS_KEYS);
  }

  await page.goto(`${base}/results`, { waitUntil: "domcontentloaded" });
  await testId("run-results").waitFor({ timeout: 30000 });
  await page.locator("canvas").first().waitFor({ timeout: 30000 });
  await mapReady().catch(() => false);
  await framesIdle();

  return harness;
}

/** The base URL a check was given, or the dev default. */
export const baseFrom = (argv) => argv[2] ?? "http://127.0.0.1:8000";

/**
 * The figures' geometry, as the one thing worth waiting to stop changing.
 *
 * Heights *and* left edges: `beside` changes the second and not much of the
 * first, and a settle that cannot see the difference would return before the
 * layout had turned on its side.
 */
export const figureGeometry = (page) =>
  page.evaluate(() =>
    ["map", "timeseries", "static"].map((figure) => {
      const element = document.querySelector(`[data-testid="figure-${figure}"]`);
      if (!element) return null;
      const { left, top, width, height } = element.getBoundingClientRect();
      return [left, top, width, height].map(Math.round);
    }),
  );

/**
 * A figure's card height and the height of its own title bar.
 *
 * Measured rather than compared against a constant: the chart headers wrap onto
 * a second row at a narrow width, so what "collapsed" means in pixels is a
 * property of the header in front of you. A collapsed card is its title bar plus
 * the card's two hairlines, and nothing else.
 */
export const figureBox = (page, figure) =>
  page.evaluate((name) => {
    const section = document.querySelector(`[data-testid="figure-${name}"]`);
    if (!section) return null;
    const strip = section.firstElementChild;
    return {
      section: section.getBoundingClientRect().height,
      strip: strip.getBoundingClientRect().height,
      stripVisible:
        strip.getBoundingClientRect().bottom <=
        section.getBoundingClientRect().bottom + 0.5,
    };
  }, figure);

/** Whether a card is folded to exactly its title bar. */
export const isCollapsedCard = (box) => Math.abs(box.section - (box.strip + 2)) <= 1;

/**
 * Stubs the native save picker, which a headless browser has nothing to click.
 *
 * Records what it was *asked* and what would have been written, which is the
 * thing worth asserting anyway.
 */
export const stubSavePicker = (page) =>
  page.evaluate(() => {
    window.__cgSaved = [];
    window.showSaveFilePicker = async (options) => ({
      createWritable: async () => ({
        write: async (text) => {
          window.__cgSaved.push({ name: options.suggestedName, text });
        },
        close: async () => {},
      }),
    });
  });

/** Clicks something that exports, and returns the file it would have written. */
export async function capture(page, trigger) {
  const before = await page.evaluate(() => window.__cgSaved.length);
  await trigger();
  await page.waitForFunction((count) => window.__cgSaved.length > count, before, {
    timeout: 15000,
  });
  return page.evaluate(() => window.__cgSaved.at(-1));
}

export const csvRows = (csv) => csv.trimEnd().split("\n");
