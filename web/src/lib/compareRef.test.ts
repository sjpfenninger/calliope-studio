import { describe, expect, it } from "vitest";

import {
  describeRef,
  formatRef,
  parseRef,
  refKey,
  runRef,
  withScenario,
  workspaceRef,
  type CompareRef,
} from "./compareRef";

/**
 * The reference grammar, which is half of a tab id and half of a query string.
 *
 * The same table appears in `tests/test_compare_api.py`. Two implementations of
 * one grammar drift, and the failure is silent in the worst way: a comparison
 * that opens on the wrong pair still looks like a comparison.
 */
const SPELLINGS: Array<[string, CompareRef]> = [
  ["workspace", { kind: "workspace", scenario: null }],
  ["workspace@high_cost", { kind: "workspace", scenario: "high_cost" }],
  // Calliope's `scenario=` also takes a joined list of override names, so a
  // comma is an ordinary character here and nothing may split on it.
  ["workspace@cold_fusion,high_cost", { kind: "workspace", scenario: "cold_fusion,high_cost" }],
  ["run.3fa85f64-5717-4562-b3fc-2c963f66afa6", { kind: "run", runId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" }],
];

describe("compareRef", () => {
  it.each(SPELLINGS)("round-trips %s", (text, ref) => {
    expect(parseRef(text)).toEqual(ref);
    expect(formatRef(ref)).toBe(text);
  });

  it.each([
    ["", "nothing"],
    ["run", "a run with no id"],
    ["run.", "a run with an empty id"],
    ["workspace.thing", "a workspace with an id"],
    ["commit.abc123", "a kind this version does not know"],
    ["run.abc@high_cost", "a run given a scenario it did not solve"],
    ["run:abc", "a colon, which a tab id splits on"],
    ["workspace@a:b", "a colon inside a scenario"],
  ])("refuses %s (%s)", (text) => {
    expect(parseRef(text)).toBeNull();
  });

  it("splits a scenario on its first @ only", () => {
    expect(parseRef("workspace@odd@name")?.kind).toBe("workspace");
    expect(formatRef(parseRef("workspace@odd@name")!)).toBe("workspace@odd@name");
  });

  it("keys a pair in order, because a is before and b is after", () => {
    const a = runRef("one");
    const b = workspaceRef();
    expect(refKey(a, b)).not.toBe(refKey(b, a));
  });

  it("changes a scenario only on the side that can have one", () => {
    expect(withScenario(workspaceRef(), "high_cost")).toEqual(workspaceRef("high_cost"));
    // A run's scenario is a fact about what it solved, not a setting.
    expect(withScenario(runRef("abc"), "high_cost")).toEqual(runRef("abc"));
  });

  it("names a side before the server has answered", () => {
    expect(describeRef(workspaceRef())).toBe("Model");
    expect(describeRef(workspaceRef("high_cost"))).toBe("Model @high_cost");
    expect(describeRef(runRef("3fa85f64-5717"))).toBe("Run 3fa85f64");
    expect(describeRef(runRef("3fa85f64-5717"), "Tuesday")).toBe("Tuesday");
  });
});
