/**
 * Resolving CSS custom properties to concrete sRGB colours.
 *
 * The design tokens are authored in `oklch` (see assets/tokens.css). Three of the
 * app's renderers live outside the DOM and cannot parse that:
 *
 * - **ECharts** renders to canvas; zrender's parser accepts only named colours,
 *   `#hex`, `rgb()/rgba()` and `hsl()/hsla()`.
 * - **MapLibre** paint expressions go through its own parser, with the same
 *   limits — its bundle contains no reference to oklch at all.
 * - **Monaco** theme colours accept `#hex`, `rgb()` and `rgba()` only, and throw
 *   `Invalid color format` on anything else.
 *
 * Painting a token onto a throwaway element makes the browser resolve `var()`
 * chains and any colour function for us — but the probe alone is *not enough*,
 * which is the bug the previous version of this had. The **computed** value of
 * `color: oklch(…)` serialises back as `oklch(…)` in current browsers; verified in
 * Chromium by `npm run token-check`, which prints it. Hence `toRgba`.
 *
 * AG Grid is the exception and needs none of this: its theming API pipes params
 * into `--ag-*` custom properties and does its mixing in CSS, so `var(--cg-*)`
 * passes straight through.
 */

let probe: HTMLSpanElement | null = null;

/** One reused element rather than one per call. */
function probeElement(): HTMLSpanElement {
  if (!probe || !probe.isConnected) {
    probe = document.createElement("span");
    probe.style.display = "none";
    probe.setAttribute("aria-hidden", "true");
    document.body.appendChild(probe);
  }
  return probe;
}

/** A token's declared text, e.g. `"oklch(24% 0 0)"` or `"13px"`. */
export function cssVar(name: string, fallback = ""): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/** A token parsed as a pixel count, for the consumers that need a number. */
export function cssVarPx(name: string, fallback: number): number {
  const parsed = Number.parseFloat(cssVar(name));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type Rgba = [red: number, green: number, blue: number, alpha: number];

/** Linear-light channel to sRGB, the usual piecewise transfer function. */
const gammaEncode = (channel: number): number =>
  channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;

/** Clamps into 0–255. Out-of-gamut oklch is clipped, as a browser would. */
const toByte = (channel: number): number =>
  Math.max(0, Math.min(255, Math.round(gammaEncode(channel) * 255)));

/** oklab to sRGB, using Björn Ottosson's matrices. */
function oklabToRgba(
  lightness: number,
  aAxis: number,
  bAxis: number,
  alpha: number,
): Rgba {
  const l = (lightness + 0.3963377774 * aAxis + 0.2158037573 * bAxis) ** 3;
  const m = (lightness - 0.1055613458 * aAxis - 0.0638541728 * bAxis) ** 3;
  const s = (lightness - 0.0894841775 * aAxis - 1.291485548 * bAxis) ** 3;

  return [
    toByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha,
  ];
}

/** Splits a colour function's body, turning percentages into fractions. */
function numbers(body: string): number[] {
  return body
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map((part) =>
      part.endsWith("%")
        ? Number.parseFloat(part) / 100
        : Number.parseFloat(part),
    );
}

/**
 * Parses whatever `getComputedStyle` handed back into sRGB bytes.
 *
 * Pure, and exported for unit testing — the conversion is the part worth
 * checking, and it cannot be checked through a browser probe.
 *
 * Returns null for anything unrecognised, so a caller falls back rather than
 * handing a canvas renderer something it will choke on.
 */
export function toRgba(computed: string): Rgba | null {
  const value = computed.trim();

  const legacy = value.match(/^rgba?\(([^)]+)\)$/i);
  if (legacy) {
    const [red, green, blue, alpha = 1] = numbers(legacy[1]);
    return [Math.round(red), Math.round(green), Math.round(blue), alpha];
  }

  const oklch = value.match(/^oklch\(([^)]+)\)$/i);
  if (oklch) {
    const [lightness, chroma, hue, alpha = 1] = numbers(oklch[1]);
    const radians = ((hue || 0) * Math.PI) / 180;
    return oklabToRgba(
      lightness,
      chroma * Math.cos(radians),
      chroma * Math.sin(radians),
      alpha,
    );
  }

  const oklab = value.match(/^oklab\(([^)]+)\)$/i);
  if (oklab) {
    const [lightness, aAxis, bAxis, alpha = 1] = numbers(oklab[1]);
    return oklabToRgba(lightness, aAxis, bAxis, alpha);
  }

  // What `color-mix(in srgb, …)` computes to. We no longer author color-mix, but
  // Tailwind's opacity modifier does and a browser may hand this back.
  const srgb = value.match(/^color\(srgb\s+([^)]+)\)$/i);
  if (srgb) {
    const [red, green, blue, alpha = 1] = numbers(srgb[1]);
    return [
      Math.round(red * 255),
      Math.round(green * 255),
      Math.round(blue * 255),
      alpha,
    ];
  }

  return null;
}

/** Resolves a token by painting it, then converting. */
function resolve(name: string): Rgba | null {
  const raw = cssVar(name);
  if (!raw) return null;

  const element = probeElement();
  // Cleared first: an invalid value leaves the previous one in place, which
  // would silently return the wrong colour rather than falling back.
  element.style.color = "";
  element.style.color = raw;
  return toRgba(getComputedStyle(element).color);
}

/** A token as `rgb(r, g, b)` / `rgba(r, g, b, a)` — safe for ECharts and MapLibre. */
export function resolvedColor(name: string, fallback: string): string {
  const rgba = resolve(name);
  if (!rgba) return fallback;
  const [red, green, blue, alpha] = rgba;
  // The space after each comma matters: Monaco's parser requires it, and both
  // other consumers accept it.
  return alpha >= 1
    ? `rgb(${red}, ${green}, ${blue})`
    : `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/** A token as `#rrggbb` / `#rrggbbaa` — required by Monaco. */
export function resolvedHex(name: string, fallback: string): string {
  const rgba = resolve(name);
  if (!rgba) return fallback;
  const [red, green, blue, alpha] = rgba;
  const pair = (channel: number) =>
    channel.toString(16).padStart(2, "0");
  const alphaPair = alpha >= 1 ? "" : pair(Math.round(alpha * 255));
  return `#${pair(red)}${pair(green)}${pair(blue)}${alphaPair}`;
}
