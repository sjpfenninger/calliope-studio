import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { toRgba } from "./cssColor";

/**
 * Every colour in the app is written once, and this is what proves it.
 *
 * `tokens.css` is the only place a literal colour may be written, and
 * `design.test.ts` enforces that for class strings. Two things escape it:
 *
 * 1. **The renderer fallbacks.** ECharts, MapLibre and Monaco cannot parse
 *    `oklch`, so they resolve through `lib/cssColor` and pass a hex for the case
 *    where the stylesheet has not landed. That path is by definition the one
 *    nobody looks at, so only a test sees it drift.
 * 2. **The hex comments**, which are what a human reads when reaching for a
 *    value — including whoever writes the next fallback.
 *
 * Checked with `toRgba` from `lib/cssColor`: the app's own converter, and the
 * same code path the renderers use at runtime.
 */

const SRC = join(import.meta.dirname, "..");
const TOKENS_CSS = readFileSync(join(SRC, "assets/tokens.css"), "utf8");

/** `oklch(24% 0 0)` → `#1f1f1f`, via the converter the renderers use. */
function hexOf(value: string): string | null {
  const rgba = toRgba(value.replace(/\s+/g, " ").trim());
  if (!rgba) return null;
  const [red, green, blue, alpha] = rgba;
  if (alpha < 1) return null; // A translucent token has no plain hex to state.
  const pair = (channel: number) => channel.toString(16).padStart(2, "0");
  return `#${pair(red)}${pair(green)}${pair(blue)}`;
}

/**
 * The largest per-channel difference between two `#rrggbb`.
 *
 * The comment ↔ `oklch` comparison crosses a conversion, and a conversion
 * rounds: demanding exactness would force the comments to encode *our* rounding,
 * which is no more true than a browser's. One unit in 255 is not a colour
 * difference; real drift is four units or more.
 */
function distance(a: string, b: string): number {
  const bytes = (hex: string) =>
    [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  const [x, y] = [bytes(a), bytes(b)];
  return Math.max(...x.map((channel, i) => Math.abs(channel - y[i])));
}

/**
 * The `--cg-*` declarations in one block, as `name → { value, stated }`.
 *
 * Reads to the `;` rather than to the end of the line, because the formatter
 * wraps a long value across three. The trailing hex comment is optional: fonts,
 * radii, durations and the translucent colours have none.
 */
function declarations(block: string): Map<string, { value: string; stated?: string }> {
  const found = block.matchAll(
    /--cg-([a-z0-9-]+)\s*:\s*([^;]+);[ \t]*(?:\/\*\s*(#[0-9a-fA-F]{6})\b)?/g,
  );
  return new Map(
    [...found].map(([, name, value, stated]) => [
      name,
      { value, stated: stated?.toLowerCase() },
    ]),
  );
}

const DARK_AT = TOKENS_CSS.indexOf('[data-cg-theme="dark"]');
const LIGHT = declarations(TOKENS_CSS.slice(TOKENS_CSS.indexOf(":root {"), DARK_AT));
const DARK = declarations(TOKENS_CSS.slice(DARK_AT));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(vue|ts)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const FILES = walk(SRC).map((path) => ({
  rel: relative(SRC, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));

describe("colour tokens", () => {
  it("states the hex its oklch actually resolves to", () => {
    const wrong = [...LIGHT.entries(), ...DARK.entries()].flatMap(
      ([name, { value, stated }]) => {
        if (!stated) return [];
        const actual = hexOf(value);
        if (!actual || distance(actual, stated) <= 1) return [];
        return [`--cg-${name}: comment says ${stated}, oklch resolves to ${actual}`];
      },
    );
    expect(wrong).toEqual([]);
  });

  it("carries enough tokens to be reading the file at all", () => {
    // A regex that quietly stopped matching would make every assertion here
    // pass on an empty set — the one way this file reports a clean palette
    // while checking nothing.
    expect(LIGHT.size).toBeGreaterThan(40);
    expect(DARK.size).toBeGreaterThan(30);
    expect(LIGHT.get("accent")?.stated).toBe("#026fff");
    expect(DARK.get("accent")?.stated).toBe("#2481fe");
  });

  it("falls back to the value the token holds", () => {
    // The light value: a fallback is only reached before the stylesheet lands,
    // when the pre-paint guard has had nothing to apply a theme to.
    const calls = FILES.flatMap(({ rel, text }) =>
      [
        ...text.matchAll(
          /(?:resolvedColor|resolvedHex|cssVar)\(\s*"(--cg-[a-z0-9-]+)"\s*,\s*"(#[0-9a-fA-F]{6})"/g,
        ),
      ].map(([, token, fallback]) => ({ rel, token, fallback: fallback.toLowerCase() })),
    );

    // Against the token's *stated* hex rather than the converted `oklch`, so
    // both sides are hand-written and the comparison can be exact. The test
    // above ties that comment to the `oklch`, so the chain still closes.
    //
    // `--cg-chart-${step}` is built from a template literal and cannot be
    // matched here; the ordinal ramp has no per-step fallback to drift.
    const wrong = calls.flatMap(({ rel, token, fallback }) => {
      const declared = LIGHT.get(token.replace("--cg-", ""));
      if (!declared) return [`${rel}  ${token} is not declared in tokens.css`];
      if (!declared.stated || declared.stated === fallback) return [];
      return [
        `${rel}  ${token} falls back to ${fallback}, tokens.css states ${declared.stated}`,
      ];
    });
    expect(wrong).toEqual([]);
  });

  it("keeps every basemap token achromatic", () => {
    // The rule tokens.css argues at length for. `token-check` asserts it in a
    // browser; here it is free, and catches the edit rather than the render.
    const chromatic = [...LIGHT.entries(), ...DARK.entries()].flatMap(
      ([name, { value }]) => {
        if (!name.startsWith("map-")) return [];
        const rgba = toRgba(value.replace(/\s+/g, " ").trim());
        if (!rgba) return [`--cg-${name} does not parse`];
        const [red, green, blue] = rgba;
        const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
        return spread <= 1 ? [] : [`--cg-${name} has a chroma of ${spread}/255`];
      },
    );
    expect(chromatic).toEqual([]);
  });
});
