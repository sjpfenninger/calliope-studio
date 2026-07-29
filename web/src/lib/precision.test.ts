import { describe, expect, it } from "vitest";

import { MAX_PRECISION, formatValue, isBadPrecision, parsePrecision } from "./precision";

describe("formatValue with no precision set", () => {
  /**
   * The whole feature is opt-in, so an unset field has to leave every surface
   * byte-identical to what it showed before there was a setting. These four
   * cases moved here verbatim from `tableRows.test.ts::formatCell` — if they
   * change, an untouched app has silently changed.
   */
  it("trims the noise a float sum leaves behind", () => {
    expect(formatValue(0.1 + 0.2)).toBe("0.3");
  });

  it("keeps an ordinary value as it is", () => {
    expect(formatValue(1234.5)).toBe("1234.5");
    expect(formatValue(0)).toBe("0");
  });

  it("goes exponential at the ends of the scale", () => {
    expect(formatValue(1e10)).toBe("1.0000e+10");
    expect(formatValue(1.31e-8)).toBe("1.3100e-8");
  });

  it("shows nothing for a gap", () => {
    expect(formatValue(undefined)).toBe("");
    expect(formatValue(NaN)).toBe("");
    expect(formatValue(Infinity)).toBe("");
  });
});

describe("formatValue at a chosen precision", () => {
  it("counts significant figures, not decimal places", () => {
    // The point of significant figures: one setting reads sensibly across the
    // orders of magnitude a single frame spans.
    expect(formatValue(1234.5678, 3)).toBe("1230");
    expect(formatValue(0.0012345678, 3)).toBe("0.00123");
  });

  it("rounds rather than truncating", () => {
    expect(formatValue(1.6, 1)).toBe("2");
    expect(formatValue(1234.5678, 6)).toBe("1234.57");
  });

  it("keeps every digit a double carries at the maximum", () => {
    expect(formatValue(1234.5678, MAX_PRECISION)).toBe("1234.5678");
  });

  it("drops trailing zeros rather than padding to the precision", () => {
    // `toPrecision` alone gives "1234.500000"; the round-trip through `Number`
    // is what makes a column of cells scannable.
    expect(formatValue(1234.5, 10)).toBe("1234.5");
  });

  it("carries the precision into the exponential ends too", () => {
    expect(formatValue(1.31e-8, 3)).toBe("1.31e-8");
    expect(formatValue(1.23456e10, 3)).toBe("1.23e+10");
    expect(formatValue(1.6e10, 1)).toBe("2e+10");
  });

  it("still shows nothing for a gap, and zero as zero", () => {
    expect(formatValue(undefined, 3)).toBe("");
    expect(formatValue(NaN, 3)).toBe("");
    // Not "0.00": an exact zero is exact at every precision.
    expect(formatValue(0, 3)).toBe("0");
  });

  it("keeps a negative value negative", () => {
    expect(formatValue(-1234.5678, 3)).toBe("-1230");
  });
});

describe("parsePrecision", () => {
  it("reads a plain count of digits", () => {
    expect(parsePrecision("3")).toBe(3);
    expect(parsePrecision(" 6 ")).toBe(6);
    expect(parsePrecision(String(MAX_PRECISION))).toBe(MAX_PRECISION);
  });

  it("treats an empty field as no rounding at all", () => {
    expect(parsePrecision("")).toBeNull();
    expect(parsePrecision("   ")).toBeNull();
    expect(parsePrecision(null)).toBeNull();
    expect(parsePrecision(undefined)).toBeNull();
  });

  it("refuses anything that is not a count of significant figures", () => {
    // Zero significant figures is not a number anyone means, and `toPrecision`
    // throws on it.
    expect(parsePrecision("0")).toBeNull();
    expect(parsePrecision("-2")).toBeNull();
    expect(parsePrecision("2.5")).toBeNull();
    // `Number` would take all of these; a count of digits is written in digits.
    expect(parsePrecision("1e3")).toBeNull();
    expect(parsePrecision("0x4")).toBeNull();
    expect(parsePrecision("abc")).toBeNull();
  });

  it("refuses more digits than a double carries", () => {
    expect(parsePrecision(String(MAX_PRECISION + 1))).toBeNull();
    expect(parsePrecision("100")).toBeNull();
  });
});

describe("isBadPrecision", () => {
  it("tells an empty field apart from a wrong one", () => {
    // Both mean "do not round", but only one of them is the user's mistake.
    expect(isBadPrecision("")).toBe(false);
    expect(isBadPrecision("abc")).toBe(true);
    expect(isBadPrecision("0")).toBe(true);
  });

  it("accepts a valid precision", () => {
    expect(isBadPrecision("4")).toBe(false);
  });
});
