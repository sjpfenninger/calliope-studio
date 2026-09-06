/**
 * The two renderings of a problem's size.
 *
 * Pure string building, but it is read at a glance beside an objective and a
 * duration, and the failure that matters is silent: a run that never built has
 * an empty `problem`, and rendering that as "0 × 0" would state, in the same
 * place and the same tone as a real answer, that the model has no variables in
 * it. Every function here returns null instead so the caller can show nothing.
 */
import { describe, expect, it } from "vitest";

import {
  compactProblemSize,
  describeProblemSize,
  hasProblemSize,
} from "@/lib/problemSize";

const LP = { variables: 5066, constraints: 6367, integer_variables: 0 };
const MILP = { variables: 3787, constraints: 4723, integer_variables: 339 };

describe("hasProblemSize", () => {
  it("is false for a run that never reached a build", () => {
    expect(hasProblemSize({})).toBe(false);
    expect(hasProblemSize(null)).toBe(false);
    expect(hasProblemSize(undefined)).toBe(false);
  });

  it("is true once either half has been counted", () => {
    expect(hasProblemSize(LP)).toBe(true);
  });
});

describe("compactProblemSize", () => {
  // Matched rather than compared: `Intl` compact notation writes "5.07K" under
  // Node's default locale and "5.07k" under some browsers', and which one a
  // reader sees is their locale, not a decision this module makes.
  it("reads as the shape of the constraint matrix", () => {
    expect(compactProblemSize(LP)).toMatch(/^5\.07k × 6\.37k$/i);
  });

  it("says so when the problem is a MILP", () => {
    // The difference between minutes and hours of solving, and nothing else in
    // the run tab says it.
    expect(compactProblemSize(MILP)).toMatch(/^3\.79k × 4\.72k · 339 int$/i);
  });

  it("is null rather than a zero when nothing was built", () => {
    expect(compactProblemSize({})).toBeNull();
  });
});

describe("describeProblemSize", () => {
  // The group separator is the reader's too, so the expectation is built the
  // same way the value is rather than spelled with a comma in it.
  const n = (value: number) => value.toLocaleString();

  it("spells the counts out where there is room", () => {
    expect(describeProblemSize(LP)).toBe(
      `${n(5066)} variables and ${n(6367)} constraints`,
    );
  });

  it("names the integer variables among them", () => {
    expect(describeProblemSize(MILP)).toBe(
      `${n(3787)} variables and ${n(4723)} constraints, ${n(339)} of them integer`,
    );
  });

  it("is null rather than a zero when nothing was built", () => {
    expect(describeProblemSize({})).toBeNull();
  });
});
