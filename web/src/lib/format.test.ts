import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatDuration,
  formatObjective,
  formatRelativeTime,
} from "./format";

/**
 * The run history is a dense two-line list, and every number in it is read at a
 * glance. These are the cases where a naive implementation produces something
 * technically correct and useless — "0s" for a build-only run, "4194304 B" for a
 * results file, "1.0000000000002e21" for an objective.
 */
describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1000, "1.0 kB"],
    [4_800_000, "4.8 MB"],
    [540_000, "540 kB"],
    [13_600_000_000, "13.6 GB"],
  ])("renders %i as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it("never shows a fractional byte", () => {
    expect(formatBytes(999)).toBe("999 B");
  });

  it("treats nonsense as nothing rather than NaN", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  it("keeps sub-second runs visible", () => {
    // A build-only run of a small model really does finish this fast, and "0s"
    // reads as "nothing happened".
    expect(formatDuration(0.42)).toBe("420ms");
  });

  it.each([
    [12.34, "12.3s"],
    [134, "2m 14s"],
    [7200, "2h 0m"],
  ])("renders %f seconds as %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it("has an em dash for a run that never finished", () => {
    expect(formatDuration(null)).toBe("—");
  });
});

describe("formatObjective", () => {
  it("groups an ordinary magnitude", () => {
    expect(formatObjective(12345.6789)).toBe((12345.679).toLocaleString());
  });

  it("goes exponential where the digits would be noise", () => {
    expect(formatObjective(1.2345e12)).toBe("1.235e+12");
    expect(formatObjective(1.2e-5)).toBe("1.200e-5");
  });

  it("keeps zero as zero, not as an exponent", () => {
    expect(formatObjective(0)).toBe("0");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-07-26T12:00:00Z");

  it.each([
    ["2026-07-26T11:59:30Z", "just now"],
    ["2026-07-26T11:20:00Z", "40m ago"],
    ["2026-07-26T04:00:00Z", "8h ago"],
    ["2026-07-24T12:00:00Z", "2d ago"],
  ])("renders %s as %s", (iso, expected) => {
    expect(formatRelativeTime(iso, now)).toBe(expected);
  });

  it("falls back to a date once relative stops meaning anything", () => {
    expect(formatRelativeTime("2026-01-02T12:00:00Z", now)).toMatch(/2026/);
  });

  it("survives a timestamp it cannot parse", () => {
    expect(formatRelativeTime("not a date", now)).toBe("—");
    expect(formatRelativeTime(null, now)).toBe("—");
  });
});
