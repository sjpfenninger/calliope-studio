/**
 * Aggregating the totals chart, the colours that follow, and locked options.
 *
 *   pnpm run smoke:charts http://127.0.0.1:8792
 *
 * The colour assertion reads the pixels off the canvas, which is the only place
 * the answer exists: colour is stamped per series in Arrow field metadata, and
 * when the aggregation moves the technologies onto the *axis* there is none to
 * be had — so every bar came out in the same ordinal ramp, a chart of eight
 * technologies with nothing to tell them apart, and a different colour from the
 * same technology on the map beside it.
 */
import { results, until } from "./harness.mjs";
import { baseFrom, openResults } from "./results-page.mjs";

const BASE = baseFrom(process.argv);
const { check, skip, finish } = results("charts");
const { browser, page, testId, consoleErrors, frames, settle, stable, quiet } =
  await openResults(BASE);

console.log(`Charts at ${BASE}`);

// Summing the nodes away is what turns this into model-wide totals by
// technology, which had no answer here at all.
const summed = await settle(() =>
  testId("static-sum-by").getByText("Sum nodes", { exact: true }).click(),
);
check(
  "the totals chart can sum the nodes away",
  summed > 0 &&
    frames.some(({ query }) => query?.sum_by === "nodes" && !query?.resample),
);

/**
 * The saturated colours actually painted into the totals chart's canvas.
 *
 * Read through `stable`, so the sample is taken once the series animation has
 * finished rather than at a guessed moment during it.
 */
const paintedColours = () =>
  page.evaluate(() => {
    const canvas = [...document.querySelectorAll('[data-testid^="figure-"]')]
      .find((figure) => figure.querySelector('[data-testid="static-sum-by"]'))
      .querySelector("canvas");
    const { data } = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 250) continue;
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      // Saturated only: the grid, the axis text and the background are grey.
      if (Math.max(r, g, b) - Math.min(r, g, b) < 30) continue;
      seen.add(`#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`);
    }
    return [...seen].sort();
  });

const techColours = await page.evaluate(async () => {
  const handle = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name.match(/\/api\/results\/([^/]+)\//))
    .find(Boolean)?.[1];
  const body = await (await fetch(`/api/results/${handle}/catalog/`)).json();
  return Object.values(body.colors).map((hex) => hex.toLowerCase());
});

// `stable`, not a sample: ECharts animates a series change over several
// frames, and a reading taken mid-animation is a blend of the old palette and
// the new.
const painted = new Set(await stable(paintedColours));
const matched = techColours.filter((hex) => painted.has(hex));
check(
  "aggregated bars take the model's technology colours",
  matched.length >= 3,
  `${matched.length} of ${new Set(techColours).size} tech colours painted`,
);

await settle(() => testId("static-sum-by").getByText("No sum", { exact: true }).click());
const unaggregated = new Set(await stable(paintedColours));
check(
  "with nothing summed, colour stays on the series",
  techColours.filter((hex) => unaggregated.has(hex)).length === 0,
);
await settle(() =>
  testId("static-sum-by").getByText("Sum nodes", { exact: true }).click(),
);

// ── Display units, on the charts side ──────────────────────────────────────
//
// The scale is applied once, in `useResultFrame`, so the chart cannot disagree
// with the table about what a number means — and the factor joins the chart's
// own merge key, because a rescale leaves every series *name* identical while
// changing every value, and a merge keyed on names alone would go on drawing the
// old numbers. That reads exactly like the setting doing nothing.
const unitField = (name) =>
  page.locator(`[data-testid="run-results"] [data-testid="units-power-${name}"]`);

/** The axis label and the largest value the totals chart is actually drawing. */
const chartScale = () =>
  page.evaluate(() => {
    const option = window.__cgCharts?.static?.getOption();
    if (!option) return null;
    const value = (point) => {
      if (typeof point === "number") return point;
      if (Array.isArray(point)) return typeof point[1] === "number" ? point[1] : null;
      if (point && typeof point.value === "number") return point.value;
      return null;
    };
    let max = 0;
    for (const series of option.series ?? []) {
      for (const point of series.data ?? []) {
        const number = value(point);
        if (number !== null) max = Math.max(max, Math.abs(number));
      }
    }
    return { axis: option.yAxis?.[0]?.name ?? "", max };
  });

const beforeUnits =
  (await unitField("scale").count()) === 1 ? await stable(chartScale) : null;

// Only a chart whose variable is measured in power can be rescaled by the power
// setting, and which variable that is belongs to the model, not to this check.
if (beforeUnits?.axis === "power" && beforeUnits.max > 0) {
  const before = beforeUnits;
  const asked = await settle(
    async () => {
      await unitField("scale").fill("/1000");
      await unitField("label").fill("GW");
    },
    // The frame is already in the browser; a unit is not a query.
    { expect: 0 },
  );
  const after = await stable(chartScale);

  check("naming a unit renames the chart's axis", after.axis === "GW", after.axis);
  check(
    "and rescales the series it draws",
    before.max > 0 && Math.abs(before.max / after.max - 1000) < 1e-6,
    `${before.max} → ${after.max}`,
  );
  check("changing a unit asks the server for nothing", asked === 0, `${asked} frames`);

  await page.locator('[data-testid="run-results"] [data-testid="units-reset"]').click();
  const reset = await stable(chartScale);
  check(
    "resetting puts the model's own numbers back",
    Math.abs(reset.max - before.max) < 1e-6,
    `${reset.max} vs ${before.max}`,
  );
} else {
  skip("display units on a chart measured in power");
}

// An option a variable cannot honour is locked and says why — never removed. A
// toggle group that loses buttons as the variable changes reads as a broken
// control, which is exactly how the first version of this was read.

/** Whether a select offers `option`, so a model without it can be skipped. */
const offers = async (select, option) => {
  await testId(select).click();
  const item = page.getByRole("option", { name: option, exact: true });
  await item.first().waitFor({ timeout: 3000 }).catch(() => {});
  const found = (await item.count()) > 0;
  if (!found) await page.keyboard.press("Escape");
  return found;
};

/** Picks an option in a select that is already open, from `offers`. */
const pickOpen = (option) =>
  settle(() => page.getByRole("option", { name: option, exact: true }).click());

const sumButtons = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="static-sum-by"] button')].map(
      (button) => ({
        label: button.textContent.trim(),
        locked: button.getAttribute("aria-disabled") === "true",
        pressed: button.getAttribute("aria-pressed") === "true",
      }),
    ),
  );

check(
  "all three sum options are offered",
  JSON.stringify((await sumButtons()).map((button) => button.label)) ===
    JSON.stringify(["No sum", "Sum nodes", "Sum techs"]),
  JSON.stringify(await sumButtons()),
);

// `total_levelised_cost` is `(costs, carriers)` — neither dimension to sum.
if (await offers("static-variable", "total_levelised_cost")) {
  await pickOpen("total_levelised_cost");
  const locked = await sumButtons();
  check(
    "an option the variable cannot honour is locked, not removed",
    locked.length === 3 && !locked[0].locked && locked[1].locked && locked[2].locked,
    JSON.stringify(locked),
  );
  check(
    "the toggle shows what the chart is actually doing",
    locked[0].pressed && !locked[1].pressed && !locked[2].pressed,
    JSON.stringify(locked),
  );

  // Forced, because `aria-disabled` already stops an ordinary click and a
  // browser refusing it says nothing about the handler. This asserts the second
  // line of defence: even a click that lands issues no query. There is nothing
  // to wait *for*, so the pause is bounding a race rather than awaiting work.
  const lockedBefore = frames.length;
  await testId("static-sum-by")
    .getByText("Sum nodes", { exact: true })
    .click({ force: true });
  await quiet(500);
  check("even a forced click on a locked option changes nothing", frames.length === lockedBefore);
} else {
  skip("locking an inapplicable sum (no such variable on this model)");
}

// ── The time-series zoom, across everything that re-renders the chart ──────
//
// A change of variable or aggregation is a `notMerge` render, and a fresh
// option starts at the whole range — so comparing two variables over one week
// meant zooming into that week twice. The window now rides on the replace, in
// axis values rather than percentages, and the slider is drawn in the canvas,
// so `dispatchAction` is the one way to zoom it and `getOption` the one way to
// read the window back — as values or as percentages, whichever ECharts holds.

/** The window the time-series chart is showing, in epoch milliseconds. */
const timeWindow = () =>
  page.evaluate(() => {
    const chart = window.__cgCharts?.timeseries;
    if (!chart) return null;
    const option = chart.getOption();
    let min = Infinity;
    let max = -Infinity;
    for (const series of option.series ?? []) {
      for (const point of series.data ?? []) {
        const x = Array.isArray(point) ? point[0] : null;
        if (typeof x !== "number") continue;
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
    if (!(max > min)) return null;
    const zoom = (option.dataZoom ?? [])[0] ?? {};
    const at = (percent, value) =>
      typeof value === "number" ? value : min + ((max - min) * percent) / 100;
    return { min, max, start: at(zoom.start ?? 0, zoom.startValue), end: at(zoom.end ?? 100, zoom.endValue) };
  });

/**
 * The percent range on the first dataZoom, for an axis whose values are not
 * times. ECharts writes the *calculated* range back onto the option after every
 * pass, so `startValue` is always present and says nothing about intent; the
 * percentages are what distinguish "everything" from a window.
 */
const rawZoom = () =>
  page.evaluate(() => {
    const zoom = (window.__cgCharts?.timeseries?.getOption().dataZoom ?? [])[0] ?? {};
    return { start: zoom.start ?? null, end: zoom.end ?? null };
  });

const zoomTo = (startValue, endValue) =>
  page.evaluate(
    ([startValue, endValue]) =>
      window.__cgCharts.timeseries.dispatchAction({
        type: "dataZoom",
        dataZoomIndex: 0,
        startValue,
        endValue,
      }),
    [startValue, endValue],
  );

/** The button that is on, in a toggle group. */
const onButton = (group) =>
  page.evaluate(
    (group) =>
      document
        .querySelector(`[data-testid="${group}"] button[data-state="on"]`)
        ?.textContent.trim() ?? null,
    group,
  );

// At the original resolution: the example model spans days, not years, so a
// fifth of a Daily axis holds no bar at all — a blank chart, with no y labels
// and so no gutter, which is a legitimate picture but not the one to measure.
const resolutionBefore = await onButton("resolution");
if (resolutionBefore !== "Original") {
  await settle(() => testId("resolution").getByText("Original", { exact: true }).click());
}

const full = await stable(timeWindow);
if (full) {
  const span = full.max - full.min;
  const week = [full.min + span * 0.4, full.min + span * 0.6];
  // Within a hundredth of the axis: a resample moves the extent by hours, and a
  // window carried as values lands on the same instants regardless.
  const holds = (window) =>
    Boolean(window) &&
    Math.abs(window.start - week[0]) < span * 0.01 &&
    Math.abs(window.end - week[1]) < span * 0.01;

  await zoomTo(...week);
  check("a script can zoom the time series", await until(async () => holds(await timeWindow())));

  // Whichever aggregation the current variable allows and is not already set.
  const sumLabel = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('[data-testid="sum-by"] button')];
    const other = buttons.find(
      (button) =>
        button.getAttribute("aria-disabled") !== "true" &&
        button.getAttribute("data-state") !== "on",
    );
    return other?.textContent.trim() ?? null;
  });
  const sumBefore = await onButton("sum-by");
  if (sumLabel && sumBefore) {
    await settle(() => testId("sum-by").getByText(sumLabel, { exact: true }).click());
    check("the zoom survives a sum-by change", holds(await stable(timeWindow)), sumLabel);
    await settle(() => testId("sum-by").getByText(sumBefore, { exact: true }).click());
  } else {
    skip("the zoom across a sum-by change (only one aggregation offered)");
  }

  const variableBefore = (await testId("timeseries-variable").innerText()).trim();
  await testId("timeseries-variable").click();
  const options = page.getByRole("option");
  await options.first().waitFor({ timeout: 3000 }).catch(() => {});
  const names = (await options.allInnerTexts()).map((text) => text.trim());
  const other = names.find((name) => name && name !== variableBefore);
  if (other) {
    await pickOpen(other);
    check("the zoom survives a variable change", holds(await stable(timeWindow)), other);
    await testId("timeseries-variable").click();
    await pickOpen(variableBefore);
  } else {
    await page.keyboard.press("Escape");
    skip("the zoom across a variable change (only one variable offered)");
  }

  // A duration curve's x is rank, not time, so the window is dropped rather
  // than carried onto an axis where it would mean something else.
  const plotBefore = await onButton("plot-type");
  await settle(() => testId("plot-type").getByText("Duration", { exact: true }).click());
  const duration = await stable(rawZoom);
  check(
    "a duration curve starts unzoomed",
    duration.start === 0 && duration.end === 100,
    JSON.stringify(duration),
  );
  check(
    "and offers nothing to reset",
    await until(async () => (await testId("zoom-reset").count()) === 0),
  );
  if (plotBefore) {
    await settle(() => testId("plot-type").getByText(plotBefore, { exact: true }).click());
  }

  // The reset button: beside the slider, under the y-axis, and only while zoomed.
  await zoomTo(...week);
  const shown = await until(async () => (await testId("zoom-reset").count()) === 1);
  check("zooming shows the reset button", shown);
  if (shown) {
    // The plot rect is the one thing that says where the slider begins:
    // `containLabel` widens the gutter to whatever the y-axis labels need, and
    // a zoom changes which labels there are. Polled, because the button follows
    // the chart a frame behind it.
    const placement = () =>
      page.evaluate(() => {
        const chart = window.__cgCharts.timeseries;
        const canvas = chart.getDom().getBoundingClientRect();
        const rect = chart.getModel().getComponent("grid").coordinateSystem.getRect();
        const slider = chart.getOption().dataZoom[1];
        const button = document.querySelector('[data-testid="zoom-reset"]').getBoundingClientRect();
        return {
          gridLeft: canvas.left + rect.x,
          bandCentre: canvas.bottom - slider.bottom - slider.height / 2,
          button: { right: button.right, centre: (button.top + button.bottom) / 2 },
        };
      });
    const besideSlider = (placed) => placed.button.right <= placed.gridLeft + 0.5;
    const onLine = (placed) => Math.abs(placed.button.centre - placed.bandCentre) <= 2;
    await until(async () => besideSlider(await placement()));
    const placed = await placement();
    check(
      "the reset button sits left of the slider",
      besideSlider(placed),
      `right edge ${placed.button.right.toFixed(1)} vs grid ${placed.gridLeft.toFixed(1)}`,
    );
    check(
      "and on the slider's own line",
      onLine(placed),
      `${placed.button.centre.toFixed(1)} vs ${placed.bandCentre.toFixed(1)}`,
    );
    await testId("zoom-reset").click();
    check(
      "reset puts the whole range back and goes away",
      await until(async () => {
        const window = await timeWindow();
        return (
          Boolean(window) &&
          window.start === window.min &&
          window.end === window.max &&
          (await testId("zoom-reset").count()) === 0
        );
      }),
    );
  }
} else {
  skip("the time-series zoom (no time axis drawn)");
}
if (resolutionBefore && resolutionBefore !== "Original") {
  await settle(() => testId("resolution").getByText(resolutionBefore, { exact: true }).click());
}

check("no console errors throughout", consoleErrors.length === 0);
await finish(browser, consoleErrors);
