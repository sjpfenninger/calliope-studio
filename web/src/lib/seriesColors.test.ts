import { describe, expect, it } from "vitest";

import type { ResultFrame, Series } from "../api/results";
import type { SumBy } from "../stores/runSelection";
import { indexColorsFor } from "./seriesColors";

/**
 * Where a technology's colour goes when the technologies are the *axis*.
 *
 * Colour is stamped per series, in the Arrow field metadata. Sum the nodes out
 * of `flow_cap` and each bar becomes a technology while the series become the
 * carriers — so there is no colour on the series to use, and every bar came out
 * the same flat blue. A chart of eight technologies drawn in one colour is the
 * one thing it must not be, and it contradicts the map and every other chart,
 * where a technology has one colour throughout the app.
 *
 * The catalogue's `colors` is the same per-model assignment the server stamps
 * into the field metadata (`results/colors.py`) arriving by a second route, so
 * this decides *where* the one answer is applied — it does not invent a second
 * one. Which is why every case below is about the decision, not the palette.
 */

const COLORS = { ccgt: "#a11", battery: "#1a1", csp: "#11a" };

function frame(overrides: Partial<ResultFrame> = {}): ResultFrame {
  const series: Series[] = [
    { key: "power", dims: { carriers: "power" }, values: Float64Array.from([1, 2]) },
  ];
  return {
    index: ["ccgt", "battery"],
    indexName: "techs",
    indexIsTime: false,
    series,
    variable: "flow_cap",
    order: "time",
    seriesDims: ["carriers"],
    unit: null,
    ...overrides,
  };
}

describe("indexColorsFor", () => {
  it("colours the axis when the technologies are on it and something was summed", () => {
    // Identity, not a copy: this is the catalogue's own map handed straight to
    // the chart, so a second assignment cannot creep in between.
    expect(indexColorsFor(frame(), "nodes", COLORS)).toBe(COLORS);
    expect(indexColorsFor(frame(), "techs", COLORS)).toBe(COLORS);
  });

  it("leaves colour on the series when nothing is summed", () => {
    // With nothing summed the series are still the comparison being made — one
    // bar per technology, split by node and carrier — and their legend is doing
    // real work. Colouring the axis as well would put two colour schemes on one
    // chart, neither of which the legend explains.
    expect(indexColorsFor(frame(), "none", COLORS)).toBeNull();
  });

  it("says nothing about an index that is not the technologies", () => {
    // A model colour is per technology and nothing else. Applying the map to an
    // axis of nodes or carriers would either miss entirely or — worse — hit a
    // node that happens to share a name with a tech and paint one bar.
    for (const indexName of ["nodes", "carriers", "timesteps", "costs", ""]) {
      expect(indexColorsFor(frame({ indexName }), "techs", COLORS)).toBeNull();
    }
  });

  it("is answered by the index and the aggregation alone", () => {
    // Not by what the series happen to carry: a frame whose series already have
    // colours is still an axis of technologies, and the decision must not flip
    // on data that has nothing to do with it.
    const coloured = frame({
      series: [
        {
          key: "power",
          dims: { carriers: "power" },
          values: Float64Array.from([1]),
          color: "#123456",
        },
      ],
    });
    expect(indexColorsFor(coloured, "nodes", COLORS)).toBe(COLORS);
  });

  it("survives a frame that has not arrived, and a catalogue with no colours", () => {
    // Both are ordinary states while a figure is loading, and the chart calls
    // this on every render — a throw here takes the pane down rather than
    // leaving it briefly uncoloured.
    expect(indexColorsFor(null, "nodes", COLORS)).toBeNull();
    expect(indexColorsFor(frame(), "nodes", null)).toBeNull();
    expect(indexColorsFor(null, "none", null)).toBeNull();
  });

  it("answers for every sum-by option", () => {
    // The option set is the store's, so this is the pairing that must hold as
    // it grows: exactly one option — "no sum" — leaves the axis uncoloured.
    const answers = (["none", "nodes", "techs"] as SumBy[]).map(
      (sum) => indexColorsFor(frame(), sum, COLORS) !== null,
    );
    expect(answers).toEqual([false, true, true]);
  });
});
