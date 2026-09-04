import { describe, expect, it } from "vitest";

import type { CompareSide } from "@/api/compare";
import { compareStatus } from "./compareStatus";

/**
 * What the Model half says when it has no diff to show.
 *
 * Pure, and tested for the same reason `geoStatus` is: these states are the
 * awkward ones to reach by hand — a model mid-edit that Calliope refuses, a
 * scenario renamed since a run was solved — so wording that lived only inside a
 * template would be wording nobody ever read back.
 */
function side(overrides: Partial<CompareSide> = {}): CompareSide {
  return {
    ref: "workspace",
    kind: "workspace",
    label: "Model",
    scenario: null,
    scenario_known: true,
    model: { source: "resolved" },
    ...overrides,
  };
}

describe("compareStatus", () => {
  it("says nothing when both sides were read cleanly", () => {
    expect(compareStatus(side(), side(), false)).toBeNull();
  });

  it("reports work in progress rather than a failure", () => {
    // Reading a model is a subprocess taking seconds. Shown as an error, every
    // comparison would appear broken for its first few seconds.
    const status = compareStatus(side(), side(), true);
    expect(status?.loading).toBe(true);
    expect(status?.tone).toBe("info");
  });

  it("names which side cannot be read, and passes on Calliope's own words", () => {
    const broken = side({
      model: { source: "unavailable", resolve_error: "KeyError: 'cost_dim_setter'" },
    });
    const status = compareStatus(side(), broken, false);

    expect(status?.tone).toBe("danger");
    // "the current model", not "a side": they are different things to go and fix.
    expect(status?.text).toContain("the current model");
    expect(status?.detail).toBe("KeyError: 'cost_dim_setter'");
  });

  it("names a scenario when that is what could not be read", () => {
    const broken = side({
      scenario: "high_cost",
      model: { source: "unavailable", reason: "nope" },
    });
    expect(compareStatus(broken, side(), false)?.text).toContain("high_cost");
  });

  it("distinguishes a run from the working tree", () => {
    const run = side({
      kind: "run",
      label: "Tuesday",
      model: { source: "unavailable", reason: "no results" },
    });
    expect(compareStatus(run, side(), false)?.text).toContain("run");
  });

  it("says so once the polls have run out, rather than loading for ever", () => {
    // The payload goes on saying `pending`; the store is what gave up. Read
    // off `pending` alone, the pane said "Reading the model…" with nothing in
    // flight and no way to tell.
    const status = compareStatus(side(), side(), true, null, true);
    expect(status?.loading).toBe(false);
    expect(status?.tone).toBe("warning");
    expect(status?.text).toContain("Refresh");
  });

  it("says when a scenario no longer exists", () => {
    // A run solved under a scenario that has since been renamed: the files
    // still compare perfectly well, so this is a warning and not a failure.
    const gone = side({ scenario: "old_name", scenario_known: false });
    const status = compareStatus(side(), gone, false);

    expect(status?.tone).toBe("warning");
    expect(status?.text).toContain("old_name");
  });

  it("reports the unreadable side before the merely renamed one", () => {
    const broken = side({ model: { source: "unavailable", reason: "nope" } });
    const gone = side({ scenario: "old_name", scenario_known: false });
    expect(compareStatus(broken, gone, false)?.tone).toBe("danger");
  });
});
