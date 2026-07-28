import { describe, expect, it } from "vitest";

import type { ResultFrame, Series } from "../api/results";
import {
  composeLabel,
  parseScale,
  parseUnit,
  quantitiesIn,
  resolveUnit,
  scaleFrame,
  unitSuffix,
} from "./units";

/**
 * Every distinct unit string the installed Calliope declares, pinned verbatim.
 *
 * Copied out of `initialise_math()` rather than invented, because the point of
 * this module is that Calliope's declarations are inconsistent in ways nobody
 * would think to make up: trailing full stops, three spellings of "one over
 * hours", an upstream `\{cost}` for `\text{cost}`, and six parameters that
 * declare three alternatives at once.
 */
describe("parseUnit", () => {
  it("reads the plain quantities", () => {
    expect(parseUnit("energy")).toEqual([{ base: "energy", exponent: 1 }]);
    expect(parseUnit("power")).toEqual([{ base: "power", exponent: 1 }]);
    expect(parseUnit("cost")).toEqual([{ base: "cost", exponent: 1 }]);
    expect(parseUnit("area")).toEqual([{ base: "area", exponent: 1 }]);
  });

  it("ignores a trailing full stop, inside the maths or outside it", () => {
    expect(parseUnit("power.")).toEqual(parseUnit("power"));
    expect(parseUnit("energy.")).toEqual(parseUnit("energy"));
    expect(parseUnit("distance.")).toEqual([{ base: "distance", exponent: 1 }]);
    expect(parseUnit("$\\text{area}$.")).toEqual(parseUnit("area"));
  });

  it("unwraps LaTeX", () => {
    expect(parseUnit("$\\text{area}$")).toEqual([{ base: "area", exponent: 1 }]);
    expect(parseUnit("$\\frac{\\text{cost}}{\\text{hour}}$")).toEqual([
      { base: "cost", exponent: 1 },
      { base: "hour", exponent: -1 },
    ]);
    expect(parseUnit("$\\frac{\\text{area}}{\\text{power}}$")).toEqual([
      { base: "area", exponent: 1 },
      { base: "power", exponent: -1 },
    ]);
  });

  it("tolerates Calliope's `\\{cost}` typo", () => {
    expect(parseUnit("$\\frac{\\{cost}}{\\text{energy}}$")).toEqual([
      { base: "cost", exponent: 1 },
      { base: "energy", exponent: -1 },
    ]);
    expect(parseUnit("$\\frac{\\{cost}}{\\text{power}\\times\\text{distance}}$")).toEqual(
      [
        { base: "cost", exponent: 1 },
        { base: "power", exponent: -1 },
        { base: "distance", exponent: -1 },
      ],
    );
  });

  /**
   * The one equivalence that has to hold. Calliope spells the same unit three
   * ways in one file, and two of them differing here would mean `1/hour` and
   * `hour^-1` scaling differently and labelling differently.
   */
  it("collapses the three spellings of one-over-hours", () => {
    const expected = [{ base: "hour", exponent: -1 }];
    expect(parseUnit("$\\text{hour}^{-1}$")).toEqual(expected);
    expect(parseUnit("$\\frac{1}{\\text{hour}}$")).toEqual(expected);
    expect(parseUnit("$\\frac{\\text{1}}{\\text{hour}}$")).toEqual(expected);
  });

  it("treats the dimensionless declarations as having no unit", () => {
    expect(parseUnit("unitless")).toEqual([]);
    expect(parseUnit("unitless.")).toEqual([]);
    expect(parseUnit("integer")).toEqual([]);
    expect(parseUnit("integer.")).toEqual([]);
  });

  it("takes the plural and singular spellings as one base", () => {
    expect(parseUnit("hours.")).toEqual([{ base: "hour", exponent: 1 }]);
    expect(parseUnit("years.")).toEqual([{ base: "year", exponent: 1 }]);
  });

  it("refuses an ambiguous declaration, in either spelling", () => {
    expect(
      parseUnit(
        "energy | $\\frac{\\text{energy}}{\\text{power}}$ | $\\frac{\\text{energy}}{\\text{area}}$",
      ),
    ).toBeNull();
    expect(parseUnit("power or $\\frac{\\text{power}}{\\text{unit}}$")).toBeNull();
  });

  it("returns null for nothing at all, and [] for a real dimensionless unit", () => {
    // Different answers, deliberately: one is "we do not know", the other is
    // "we know, and it has no dimension".
    expect(parseUnit(null)).toBeNull();
    expect(parseUnit("")).toBeNull();
    expect(parseUnit(undefined)).toBeNull();
    expect(parseUnit("unitless")).toEqual([]);
  });

  it("refuses malformed maths rather than guessing at it", () => {
    expect(parseUnit("$\\frac{\\text{cost}$")).toBeNull();
    expect(parseUnit("$\\sqrt{\\text{power}}$")).toBeNull();
    expect(parseUnit("$\\text{power}^{half}$")).toBeNull();
  });

  it("keeps a base it has never heard of, so custom math still labels", () => {
    expect(parseUnit("tonnes")).toEqual([{ base: "tonnes", exponent: 1 }]);
  });

  it("cancels a base against itself", () => {
    expect(parseUnit("$\\frac{\\text{energy}}{\\text{energy}}$")).toEqual([]);
  });
});

describe("parseScale", () => {
  it("reads a bare number", () => {
    expect(parseScale("1000")).toBe(1000);
    expect(parseScale("0.001")).toBe(0.001);
    expect(parseScale("1e-3")).toBe(0.001);
  });

  it("reads a division, which is how anyone says it", () => {
    expect(parseScale("/1000")).toBe(0.001);
    expect(parseScale("/ 1000")).toBe(0.001);
    expect(parseScale("÷1000")).toBe(0.001);
  });

  it("reads a multiplication", () => {
    expect(parseScale("*100")).toBe(100);
    expect(parseScale("x100")).toBe(100);
    expect(parseScale("×100")).toBe(100);
  });

  it("treats empty as no scaling at all", () => {
    expect(parseScale("")).toBe(1);
    expect(parseScale("   ")).toBe(1);
  });

  it("refuses what is not a scale, and refuses zero", () => {
    expect(parseScale("GWh")).toBeNull();
    expect(parseScale("1e")).toBeNull();
    // Never meant, and it silently flattens every chart to a straight line.
    expect(parseScale("0")).toBeNull();
    expect(parseScale("/0")).toBeNull();
  });
});

describe("resolveUnit", () => {
  it("falls back to the generalised name, so an axis is never bare", () => {
    expect(resolveUnit("energy", {})).toEqual({ factor: 1, label: "energy" });
    expect(resolveUnit("power.", {})).toEqual({ factor: 1, label: "power" });
  });

  it("applies the scale and the label the user gave", () => {
    const prefs = { energy: { scale: "/1000", label: "GWh" } };
    expect(resolveUnit("energy", prefs)).toEqual({ factor: 0.001, label: "GWh" });
  });

  it("derives a composite from its parts, with no separate setting", () => {
    const prefs = {
      cost: { scale: "1e-6", label: "M€" },
      energy: { scale: "/1000", label: "GWh" },
    };
    const resolved = resolveUnit("$\\frac{\\{cost}}{\\text{energy}}$", prefs);
    // 1e-6 cost per 1e-3 energy: the values are a thousandth of what they were.
    expect(resolved.factor).toBeCloseTo(1e-3, 12);
    expect(resolved.label).toBe("M€/GWh");
  });

  it("labels the fixed bases without offering them as settings", () => {
    const prefs = { cost: { scale: "", label: "€" } };
    expect(resolveUnit("$\\frac{\\text{cost}}{\\text{hour}}$", prefs)).toEqual({
      factor: 1,
      label: "€/h",
    });
  });

  it("leaves an ambiguous or unreadable unit entirely alone", () => {
    const prefs = { energy: { scale: "/1000", label: "GWh" } };
    // The declaration says energy *or* energy/power *or* energy/area. Scaling on
    // a guess would be a wrong number presented as a right one.
    const ambiguous = resolveUnit(
      "energy | $\\frac{\\text{energy}}{\\text{power}}$",
      prefs,
    );
    expect(ambiguous).toEqual({ factor: 1, label: "" });
    expect(resolveUnit(null, prefs)).toEqual({ factor: 1, label: "" });
    expect(resolveUnit("unitless", prefs)).toEqual({ factor: 1, label: "" });
  });

  it("ignores a scale that is not yet a number", () => {
    // Half-typed is the normal state of a field on the way to `1e-3`.
    const prefs = { energy: { scale: "1e", label: "GWh" } };
    expect(resolveUnit("energy", prefs)).toEqual({ factor: 1, label: "GWh" });
  });
});

describe("composeLabel", () => {
  it("writes a reciprocal as 1 over the denominator", () => {
    expect(composeLabel([{ base: "hour", exponent: -1 }], {})).toBe("1/h");
  });

  it("writes a power greater than one", () => {
    expect(composeLabel([{ base: "distance", exponent: 2 }], {})).toBe("distance^2");
  });

  it("joins several bases on one side", () => {
    expect(
      composeLabel(
        [
          { base: "cost", exponent: 1 },
          { base: "power", exponent: -1 },
          { base: "distance", exponent: -1 },
        ],
        { cost: { scale: "", label: "€" }, power: { scale: "", label: "MW" } },
      ),
    ).toBe("€/MW·distance");
  });
});

describe("quantitiesIn", () => {
  it("offers only what the model's variables actually involve", () => {
    expect(
      quantitiesIn({
        flow_out: "energy",
        flow_cap: "power",
        cost: "cost",
        purchased_units: "integer",
        capacity_factor: "",
      }),
    ).toEqual(["energy", "power", "cost"]);
  });

  it("finds a quantity buried in a composite", () => {
    expect(quantitiesIn({ cost_flow_cap: "$\\frac{\\{cost}}{\\text{power}}$" })).toEqual([
      "power",
      "cost",
    ]);
  });

  it("copes with a catalogue that has no units at all", () => {
    expect(quantitiesIn({})).toEqual([]);
  });
});

function series(key: string, values: number[]): Series {
  return { key, dims: {}, values: Float64Array.from(values) };
}

function frame(values: number[]): ResultFrame {
  return {
    index: values.map((_, i) => String(i)),
    indexName: "timesteps",
    indexIsTime: false,
    series: [series("a", values)],
    variable: "flow_out",
    order: "time",
    seriesDims: [],
    unit: "energy",
  };
}

describe("scaleFrame", () => {
  it("multiplies every value", () => {
    const scaled = scaleFrame(frame([1000, 2000]), 0.001);
    expect(Array.from(scaled!.series[0].values)).toEqual([1, 2]);
  });

  it("returns the very same frame when there is nothing to do", () => {
    // Identity, not a copy: this runs on every batch of every chart, and the
    // unscaled case is the default one.
    const original = frame([1, 2]);
    expect(scaleFrame(original, 1)).toBe(original);
    expect(scaleFrame(null, 0.5)).toBeNull();
  });

  it("leaves a gap a gap", () => {
    const scaled = scaleFrame(frame([1000, NaN]), 0.001);
    expect(scaled!.series[0].values[1]).toBeNaN();
  });

  it("does not disturb the index or the identity of the series", () => {
    const original = frame([1000]);
    const scaled = scaleFrame(original, 0.001)!;
    expect(scaled.index).toEqual(original.index);
    expect(scaled.series[0].key).toBe("a");
    expect(scaled.variable).toBe("flow_out");
  });
});

describe("unitSuffix", () => {
  it("is empty when there is nothing to say", () => {
    expect(unitSuffix(null)).toBe("");
    expect(unitSuffix({ factor: 1, label: "" })).toBe("");
    expect(unitSuffix({ factor: 1, label: "GWh" })).toBe(" (GWh)");
  });
});
