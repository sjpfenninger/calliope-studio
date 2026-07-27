import * as echarts from "echarts";

import { cssVar, cssVarPx, resolvedColor } from "../lib/cssColor";

/**
 * ECharts themes built from the CSS design tokens at runtime.
 *
 * v0.2.0 had to keep `tokens.css` and a Python `PlotTheme` in step by hand,
 * because Plotly and Bokeh could not read CSS custom properties. Charts are built
 * in the browser now, so the tokens can be read directly and there is one source
 * of truth for colour. Do not reintroduce a second one.
 *
 * ECharts renders to canvas and cannot parse `oklch`, so every colour goes
 * through `lib/cssColor`, which paints the token and converts what comes back.
 */

export const THEME_NAME = "calliope-studio";

/**
 * The ordinal fallback ramp, for series with no technology identity — carriers,
 * cost classes, a bar comparison.
 *
 * This is deliberately **not** the technology palette. A technology's colour is
 * per-model data: it must be identical in the editor, on the map and in every
 * chart, and the model's own `color:` parameter has to win, so it is assigned in
 * `src/calliope_studio/results/colors.py` and arrives per series in Arrow field
 * metadata, which `ResultChart` applies as `itemStyle.color`. A series carrying
 * one never reaches this array.
 *
 * One hue family with stepped lightness, so the two can never be confused:
 * technology series read as distinct categories, ordinal series as a sequence.
 */
const ORDINAL_RAMP = [1, 2, 3, 4, 5];

export function buildTheme() {
  const text = resolvedColor("--cg-text", "#1f1f1f");
  const muted = resolvedColor("--cg-text-muted", "#6c6c6c");
  // The subtle tier: gridlines should be felt rather than read.
  const border = resolvedColor("--cg-border-subtle", "#e9e9e9");
  const divider = resolvedColor("--cg-border", "#dcdcdc");
  const surface = resolvedColor("--cg-surface", "#ffffff");
  const accent = resolvedColor("--cg-accent", "#026fff");
  const fontFamily = cssVar("--cg-font-sans", "system-ui, sans-serif");
  const fontSize = cssVarPx("--cg-font-size-sm", 12);

  const axis = {
    axisLine: { lineStyle: { color: border } },
    // Labels carry the scale; ticks as well as gridlines is one mark too many.
    axisTick: { show: false, lineStyle: { color: border } },
    axisLabel: { color: muted, fontFamily, fontSize },
    splitLine: { lineStyle: { color: border } },
  };

  return {
    color: ORDINAL_RAMP.map((step) =>
      resolvedColor(`--cg-chart-${step}`, "#055bcc"),
    ),
    // Transparent, so a chart sits on whatever surface hosts it rather than
    // punching a white rectangle through a dark theme.
    backgroundColor: "transparent",
    textStyle: { color: text, fontFamily, fontSize },
    title: { textStyle: { color: text, fontFamily, fontSize } },
    legend: { textStyle: { color: muted, fontFamily, fontSize } },
    tooltip: {
      backgroundColor: surface,
      borderColor: divider,
      borderWidth: 1,
      textStyle: { color: text, fontFamily, fontSize },
      extraCssText: "box-shadow: none; border-radius: 4px;",
    },
    // The zoom slider is the usual thing left looking light in a dark theme,
    // because it is chrome rather than data.
    dataZoom: [
      {
        borderColor: border,
        fillerColor: resolvedColor("--cg-accent-soft", "#ebf2fe"),
        handleStyle: { color: surface, borderColor: accent },
        moveHandleStyle: { color: divider },
        dataBackground: {
          lineStyle: { color: border },
          areaStyle: { color: border },
        },
        selectedDataBackground: {
          lineStyle: { color: muted },
          areaStyle: { color: muted },
        },
        textStyle: { color: muted, fontFamily, fontSize: 10 },
      },
    ],
    categoryAxis: axis,
    valueAxis: axis,
    timeAxis: axis,
    logAxis: axis,
  };
}

let registeredFor = -1;

/**
 * Registers the theme for the given revision, if it has changed.
 *
 * Keyed on the UI store's revision counter rather than on the DOM attribute: the
 * attribute is a proxy, and a token can change without the light/dark mode doing
 * so. The counter is bumped after the attribute is written, so reading computed
 * styles here is safe.
 *
 * Returns the theme name, for `echarts.init`.
 */
export function ensureTheme(revision: number): string {
  if (registeredFor !== revision) {
    echarts.registerTheme(THEME_NAME, buildTheme());
    registeredFor = revision;
  }
  return THEME_NAME;
}
