import * as echarts from "echarts";

/**
 * ECharts themes built from the CSS design tokens at runtime.
 *
 * v0.2.0 had to keep `tokens.css` and a Python `PlotTheme` in step by hand,
 * because Plotly and Bokeh could not read CSS custom properties. Charts are
 * built in the browser now, so the tokens can be read directly and there is one
 * source of truth for colour. Do not reintroduce a second one.
 */

export const THEME_NAME = "calligraph";

function token(name: string, fallback = ""): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/**
 * Resolves a token to a concrete colour.
 *
 * The ramp is authored in `oklch` and some tokens use `color-mix`, neither of
 * which ECharts can parse — it renders to canvas, not the DOM. Painting the
 * value onto a throwaway element lets the browser do the conversion for us.
 */
function resolveColor(name: string, fallback: string): string {
  const raw = token(name);
  if (!raw) return fallback;

  const probe = document.createElement("span");
  probe.style.color = raw;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed || fallback;
}

export function buildTheme() {
  const text = resolveColor("--cg-text", "#090909");
  const muted = resolveColor("--cg-text-muted", "#525252");
  const border = resolveColor("--cg-border", "#dedede");
  const surface = resolveColor("--cg-surface", "#ffffff");
  const fontFamily = token("--cg-font-ui", "system-ui, sans-serif");
  const fontSize = parseInt(token("--cg-text-sm", "12px"), 10) || 12;

  const axis = {
    axisLine: { lineStyle: { color: border } },
    axisTick: { lineStyle: { color: border } },
    axisLabel: { color: muted, fontFamily, fontSize },
    splitLine: { lineStyle: { color: border, opacity: 0.6 } },
  };

  return {
    // Transparent, so a chart sits on whatever surface hosts it rather than
    // punching a white rectangle through a dark theme.
    backgroundColor: "transparent",
    textStyle: { color: text, fontFamily, fontSize },
    title: { textStyle: { color: text, fontFamily, fontSize } },
    legend: { textStyle: { color: muted, fontFamily, fontSize } },
    tooltip: {
      backgroundColor: surface,
      borderColor: border,
      textStyle: { color: text, fontFamily, fontSize },
    },
    categoryAxis: axis,
    valueAxis: axis,
    timeAxis: axis,
    logAxis: axis,
  };
}

let registeredFor: string | null = null;

/**
 * Registers the theme for the active colour scheme, if it has changed.
 *
 * Returns the theme name so callers can pass it to `echarts.init`.
 */
export function ensureTheme(): string {
  const mode = document.documentElement.dataset.cgTheme ?? "light";
  if (registeredFor !== mode) {
    echarts.registerTheme(THEME_NAME, buildTheme());
    registeredFor = mode;
  }
  return THEME_NAME;
}

/** Forces the theme to be rebuilt, after the colour scheme changes. */
export function invalidateTheme(): void {
  registeredFor = null;
}
