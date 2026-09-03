import { describe, expect, it } from "vitest";

import { RESOLUTIONS, SUM_OPTIONS, type SumBy } from "../stores/runSelection";
import {
  RESOLUTION_LABELS,
  SUM_LABELS,
  chooseSum,
  keepOne,
} from "./chartControls";

/**
 * The two guards standing between a toggle group and a figure with no way back.
 *
 * A toggle group deselects on a second click, so every one of these controls can
 * emit `undefined` for a state the view does not have — "no plot type", "no
 * resolution". Writing that into the store blanks the figure, and since the
 * control now shows nothing selected there is no click that restores it: the
 * user has to guess which option was live. Both functions are one line, which is
 * exactly why the copies of them drifted.
 */

describe("keepOne", () => {
  it("keeps the current value when the group emits nothing", () => {
    // The deselect, in all three shapes a toggle group produces it.
    expect(keepOne(undefined, "Bar")).toBe("Bar");
    expect(keepOne(null, "Bar")).toBe("Bar");
    expect(keepOne("", "Bar")).toBe("Bar");
  });

  it("adopts a value the group does emit", () => {
    expect(keepOne("Duration", "Bar")).toBe("Duration");
    expect(keepOne("Daily", "Original resolution")).toBe("Daily");
  });

  it("guards emptiness only, and does not police membership", () => {
    // Worth stating because the name suggests otherwise: there is no option set
    // here to check against. `keepOne` reproduces `:allow-empty="false"` and
    // nothing more — the *set* is policed by the store, and by `chooseSum` for
    // the one control where an option can become unavailable.
    expect(keepOne("not an option", "Bar")).toBe("not an option");
  });

  it("keeps a falsy current value rather than inventing one", () => {
    // Nothing passes an empty current today, and if something did, returning
    // some other option would be a change the user did not ask for.
    expect(keepOne("", "" as string)).toBe("");
  });
});

describe("chooseSum", () => {
  const nothingLocked = () => false;
  const lock = (...locked: SumBy[]) => (value: SumBy) => locked.includes(value);

  it("adopts an option the variable can honour", () => {
    expect(chooseSum("techs", "none" as SumBy, nothingLocked)).toBe("techs");
  });

  it("keeps the current value when the group emits nothing", () => {
    expect(chooseSum(undefined, "techs" as SumBy, nothingLocked)).toBe("techs");
  });

  it("refuses an option whose dimension the variable does not have", () => {
    // "Sum nodes" on a variable with no `nodes` dimension is not a slower or
    // emptier chart, it is a query the server cannot answer — and the control
    // is drawn disabled, so a click that still landed would be the control
    // lying about what it does. `smoke-charts` asserts the same thing on a real
    // model; this is the unit underneath it.
    expect(chooseSum("nodes", "none" as SumBy, lock("nodes"))).toBe("none");
  });

  it("holds the current value even when the current value is itself locked", () => {
    // A variable change can lock the option that is already selected. The store
    // is what re-derives an effective sum in that case; this must not quietly
    // pick a different one behind it, or the toggle and the chart disagree.
    expect(chooseSum(undefined, "nodes" as SumBy, lock("nodes"))).toBe("nodes");
  });

  it("asks the lock about the value it is about to apply, not the one emitted", () => {
    // The order matters: `keepOne` first, so a deselect is resolved to the
    // current value and *that* is what the lock is consulted about. Consulting
    // the lock about `undefined` would ask a nonsense question.
    const asked: unknown[] = [];
    chooseSum(undefined, "techs" as SumBy, (value) => {
      asked.push(value);
      return false;
    });
    expect(asked).toEqual(["techs"]);
  });
});

describe("the labels every picker reads", () => {
  it("labels every sum-by option", () => {
    // `SUM_LABELS[option]` is interpolated with no fallback, so a missing entry
    // renders an empty toggle: a button with nothing on it, which reads as a
    // rendering fault rather than as an option.
    for (const option of SUM_OPTIONS) {
      expect(SUM_LABELS[option]).toBeTypeOf("string");
      expect(SUM_LABELS[option]).not.toBe("");
    }
    // And nothing labelled that is not offered, which would be an option the
    // user is told about and cannot pick.
    expect(Object.keys(SUM_LABELS).sort()).toEqual([...SUM_OPTIONS].sort());
  });

  it("labels every resolution, shortening only where it has to", () => {
    // Here the call sites do fall back (`RESOLUTION_LABELS[name] ?? name`), so
    // the contract is that the pair always yields text — and that the override
    // exists only for the one caption wide enough to wrap a figure header onto
    // a second row, since a collapsed figure *is* its title bar.
    for (const name of Object.keys(RESOLUTIONS)) {
      const label = RESOLUTION_LABELS[name] ?? name;
      expect(label).toBeTypeOf("string");
      expect(label).not.toBe("");
    }
    expect(RESOLUTION_LABELS["Original resolution"]).toBe("Original");
  });

  it("does not shorten a resolution that no longer exists", () => {
    // An override for a dropped key is dead weight that reads as a live rule.
    for (const name of Object.keys(RESOLUTION_LABELS)) {
      expect(Object.keys(RESOLUTIONS)).toContain(name);
    }
  });
});
