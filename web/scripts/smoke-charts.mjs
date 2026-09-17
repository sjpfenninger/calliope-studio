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
    // The whole window, not the first batch's worth of it: a year arrives in
    // several batches and the replace happens on the first, whose axis ends
    // months before the window does.
    const afterSum = await stable(timeWindow);
    check("the zoom survives a sum-by change", holds(afterSum), `${sumLabel}: ${JSON.stringify(afterSum)} for ${JSON.stringify(week)}`);
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
    const afterVariable = await stable(timeWindow);
    check("the zoom survives a variable change", holds(afterVariable), `${other}: ${JSON.stringify(afterVariable)} for ${JSON.stringify(week)}`);
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

// The from/to boxes: the same window the slider moves, as days. A `from`
// alone picks the week starting there; both are read back through the option
// since the slider is painted, not in the DOM. Still at the original
// resolution: a typed window is clipped to the axis as drawn, and a Daily
// axis ends at the last day's *start*, so a day typed against it clips to
// nothing.
const boxes = async () => ({
  from: await testId("date-from").inputValue(),
  to: await testId("date-to").inputValue(),
});
const windowValues = () =>
  page.evaluate(() => {
    const zoom = window.__cgCharts.timeseries.getOption().dataZoom[0];
    return { start: zoom.startValue, end: zoom.endValue };
  });
const dateFrom = testId("date-from");
const DAY = 86_400_000;
const dayText = (ms) => new Date(ms).toISOString().slice(0, 10);
const boxesOffered =
  (await dateFrom.count()) > 0 && (await dateFrom.getAttribute("aria-disabled")) !== "true";
// The model's own span, read off the box bounds. The example models are two
// and five days long, so a week from any day but the first runs past the
// data and the `to` box reads as the *last* day rather than the seventh —
// which is the case worth checking, since a year-long model makes the clip
// invisible.
const first = boxesOffered ? Date.parse(`${await dateFrom.getAttribute("min")}T00:00:00Z`) : NaN;
const last = boxesOffered ? Date.parse(`${await dateFrom.getAttribute("max")}T00:00:00Z`) : NaN;
if (!boxesOffered) {
  skip("the from/to boxes (none offered, or no time axis)");
} else if (!(last >= first + DAY)) {
  skip("the from/to boxes (the model is shorter than two days)");
} else {
  // The second day, not the first: a week from the first day of a short
  // model covers all of it, and a window over everything is no window.
  const from = dayText(first + DAY);
  const weekEnd = dayText(Math.min(first + 7 * DAY, last));
  const fullExtent = await timeWindow();
  await settle(async () => {
    await dateFrom.fill(from);
    await dateFrom.dispatchEvent("change");
  });
  const typed = await stable(boxes);
  check("a from day fills in the week that starts on it, held within the data", typed.to === weekEnd, JSON.stringify(typed));
  const applied = await stable(windowValues);
  // The end is the day after `to`, or the data's last instant if that comes
  // first — `windowFromDays` clips to the extent.
  const expectedEnd = Math.min(Date.parse(`${weekEnd}T00:00:00Z`) + DAY, fullExtent?.max ?? Infinity);
  check(
    "and the chart zooms to it",
    applied.start === first + DAY && applied.end === expectedEnd,
    JSON.stringify({ applied, expected: { start: first + DAY, end: expectedEnd } }),
  );

  // A date box reads as "" while a segment is being typed, and fires `change`
  // on every segment. Typing the first digit into `to` used to empty `from`
  // and drop the window; the window has to sit still until a whole day is in.
  const dateTo = testId("date-to");
  await dateTo.evaluate((box) => {
    box.value = "";
    box.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const midEdit = await stable(boxes);
  const held = await stable(windowValues);
  check(
    "a to box mid-edit leaves from and the window alone",
    midEdit.from === from && held.start === applied.start && held.end === applied.end,
    JSON.stringify({ midEdit, held }),
  );
  // Left empty and tabbed out of, the box shows the window's day again.
  await dateTo.evaluate((box) => box.dispatchEvent(new Event("blur")));
  const resynced = await stable(boxes);
  check("and snaps back to the window's day on blur", resynced.to === weekEnd, JSON.stringify(resynced));

  // The other way: a window set on the chart shows up in the boxes. A day
  // and a half from the start, so it is inside even the two-day model and
  // distinct from the week just typed.
  const dragStart = first + 12 * 3_600_000;
  const dragEnd = Math.min(dragStart + DAY, fullExtent?.max ?? dragStart + DAY);
  await settle(() =>
    page.evaluate(
      ([s, e]) =>
        window.__cgCharts.timeseries.dispatchAction({
          type: "dataZoom",
          dataZoomIndex: 0,
          startValue: s,
          endValue: e,
        }),
      [dragStart, dragEnd],
    ),
  );
  const followed = await stable(boxes);
  check(
    "dragging the chart fills the boxes in",
    followed.from === dayText(dragStart) && followed.to === dayText(dragEnd - 1),
    JSON.stringify({ followed, expected: { from: dayText(dragStart), to: dayText(dragEnd - 1) } }),
  );

  if (await until(async () => (await testId("zoom-reset").count()) === 1)) {
    await settle(() => testId("zoom-reset").click());
    const cleared = await stable(boxes);
    check("and a reset empties them", cleared.from === "" && cleared.to === "", JSON.stringify(cleared));
  } else {
    skip("the boxes emptying on reset (no reset button shown)");
  }
}
if (resolutionBefore && resolutionBefore !== "Original") {
  await settle(() => testId("resolution").getByText(resolutionBefore, { exact: true }).click());
}

// The overlay: a second variable as a line on a right-hand axis of its own,
// over whatever the main chart shows. Read back through `getOption`, since an
// axis is a painted thing with no element to reach.
const overlayShape = () =>
  page.evaluate(() => {
    const option = window.__cgCharts.timeseries.getOption();
    return {
      axes: option.yAxis.length,
      lines: option.series.filter((entry) => entry.yAxisIndex === 1).length,
      stacked: option.series.filter((entry) => entry.yAxisIndex === 1 && entry.stack).length,
    };
  });
await testId("overlay-variable").click();
const overlayOptions = page.getByRole("option");
await overlayOptions.first().waitFor({ timeout: 3000 }).catch(() => {});
const overlayNames = (await overlayOptions.allInnerTexts()).map((text) => text.trim());
const overlayPick = overlayNames.find((name) => name && name !== "No overlay");
if (overlayPick) {
  const overlayPlotBefore = await onButton("plot-type");
  await pickOpen(overlayPick);
  const drawn = await stable(overlayShape);
  check(
    "an overlay adds a second axis and lines on it, unstacked",
    drawn.axes === 2 && drawn.lines > 0 && drawn.stacked === 0,
    JSON.stringify(drawn),
  );

  // Not on a duration curve: the control keeps its choice but goes quiet.
  await settle(() => testId("plot-type").getByText("Duration", { exact: true }).click());
  const onDuration = await stable(overlayShape);
  check(
    "and is not drawn on a duration curve",
    onDuration.axes === 1 &&
      onDuration.lines === 0 &&
      (await testId("overlay-variable").getAttribute("aria-disabled")) === "true",
    JSON.stringify(onDuration),
  );
  await settle(() =>
    testId("plot-type").getByText(overlayPlotBefore ?? "Bar", { exact: true }).click(),
  );
  check("but comes back with the time axis", (await stable(overlayShape)).axes === 2);

  await testId("overlay-variable").click();
  await pickOpen("No overlay");
  const gone = await stable(overlayShape);
  check("switching the overlay off takes its axis away", gone.axes === 1 && gone.lines === 0);
} else {
  await page.keyboard.press("Escape");
  skip("the overlay (no time-series variable offered)");
}

check("no console errors throughout", consoleErrors.length === 0);
await finish(browser, consoleErrors);
