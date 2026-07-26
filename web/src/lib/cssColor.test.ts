import { describe, expect, it } from "vitest";

import { toRgba } from "./cssColor";

/**
 * The oklch conversion is the part worth testing.
 *
 * It exists because painting a token onto an element and reading it back is not
 * enough: browsers serialise the computed value of `color: oklch(…)` back as
 * `oklch(…)`, and zrender, MapLibre and Monaco all fail to parse that. The probe
 * itself cannot be unit tested — it needs a browser — but the conversion can, and
 * it is where an arithmetic slip would go unnoticed.
 *
 * Expected values are the tokens from assets/tokens.css and the hexes recorded in
 * its comments, so this doubles as a check that those comments are honest.
 */
describe("toRgba", () => {
  it("parses what a browser actually returns for an oklch token", () => {
    // Chromium serialises the computed value with lightness as a 0–1 number.
    expect(toRgba("oklch(0.24 0 0)")).toEqual([31, 31, 31, 1]);
  });

  it("accepts the percentage form the tokens are authored in", () => {
    expect(toRgba("oklch(24% 0 0)")).toEqual([31, 31, 31, 1]);
  });

  it.each([
    ["--cg-text", "oklch(24% 0 0)", "#1f1f1f"],
    ["--cg-bg", "oklch(96.5% 0 0)", "#f3f3f3"],
    ["--cg-accent", "oklch(58.1% 0.23 259.5)", "#026fff"],
    ["--cg-border", "oklch(89.5% 0 0)", "#dcdcdc"],
    ["--cg-text-muted", "oklch(53% 0 0)", "#6c6c6c"],
    ["--cg-success", "oklch(57% 0.145 150)", "#1e8e46"],
    ["--cg-danger", "oklch(57% 0.2 26)", "#d43031"],
    // Dark-mode accent, which has its own hue and chroma.
    ["--cg-accent (dark)", "oklch(62% 0.205 258)", "#2481fe"],
  ])("converts %s to the hex its comment claims", (_token, oklch, hex) => {
    const rgba = toRgba(oklch);
    expect(rgba).not.toBeNull();
    const [red, green, blue] = rgba!;
    const actual = `#${[red, green, blue]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")}`;
    // Within one step per channel: the comments are rounded, and a browser's own
    // rounding differs in the last bit.
    const expected = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    [red, green, blue].forEach((channel, index) => {
      expect(Math.abs(channel - expected[index]), `${actual} vs ${hex}`).toBeLessThanOrEqual(1);
    });
  });

  it("carries alpha through", () => {
    expect(toRgba("oklch(58.1% 0.23 259.5 / 0.35)")?.[3]).toBeCloseTo(0.35);
    expect(toRgba("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3, 0.5]);
  });

  it("reads the legacy forms unchanged", () => {
    expect(toRgba("rgb(10, 20, 30)")).toEqual([10, 20, 30, 1]);
    expect(toRgba("  rgb(10, 20, 30)  ")).toEqual([10, 20, 30, 1]);
  });

  it("reads oklab, which is what color-mix(in oklab) computes to", () => {
    // Tailwind's own opacity modifier mixes in oklab, so this arrives in practice.
    expect(toRgba("oklab(0.24 0 0)")).toEqual([31, 31, 31, 1]);
  });

  it("reads color(srgb …), which is what color-mix(in srgb) computes to", () => {
    expect(toRgba("color(srgb 1 0 0)")).toEqual([255, 0, 0, 1]);
    expect(toRgba("color(srgb 0 0 0 / 0.5)")).toEqual([0, 0, 0, 0.5]);
  });

  it("clips an out-of-gamut colour rather than overflowing", () => {
    const rgba = toRgba("oklch(70% 0.4 140)");
    expect(rgba).not.toBeNull();
    rgba!.slice(0, 3).forEach((channel) => {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    });
  });

  it.each(["", "  ", "transparent", "var(--nope)", "oklch()", "#1f1f1f", "hsl(0 0% 0%)"])(
    "returns null for %o rather than guessing",
    (input) => {
      // A caller falls back to its hardcoded default; handing a canvas renderer
      // something it cannot parse would throw at paint time instead.
      expect(toRgba(input)).toBeNull();
    },
  );
});
