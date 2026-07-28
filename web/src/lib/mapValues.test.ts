import { describe, expect, it } from "vitest";

import type { ResultFrame, Series } from "../api/results";
import { largestMagnitude, nodeSlices, nodeTotals, valueExtent } from "./mapValues";

function series(
  key: string,
  values: number[],
  dims: Record<string, string> = {},
  color?: string,
): Series {
  return { key, values: Float64Array.from(values), dims, color };
}

function frame(index: string[], columns: Series[]): ResultFrame {
  return {
    index,
    indexName: "nodes",
    indexIsTime: false,
    series: columns,
    variable: "flow_cap",
    order: "time",
    seriesDims: ["techs", "carriers"],
  };
}

describe("nodeTotals", () => {
  it("sums the series that survived the query", () => {
    // `sum_by` collapses one dimension server-side; `carriers` arrives as
    // separate columns and the map wants one number.
    const totals = nodeTotals(
      frame(
        ["region1", "region2"],
        [series("power", [10, 4]), series("heat", [2, 1])],
      ),
    );
    expect(totals).toEqual({ region1: 12, region2: 5 });
  });

  it("treats a missing series as absent rather than as poison", () => {
    // A NaN reaching the sum would make the node's marker vanish entirely.
    const totals = nodeTotals(
      frame(["region1"], [series("power", [NaN]), series("heat", [3])]),
    );
    expect(totals).toEqual({ region1: 3 });
  });

  it("leaves a node summing to zero out", () => {
    const totals = nodeTotals(frame(["region1"], [series("power", [0])]));
    expect(totals).toEqual({});
  });

  it("is empty without a frame", () => {
    expect(nodeTotals(null)).toEqual({});
  });
});

describe("nodeSlices", () => {
  it("groups by technology and keeps the server's colour", () => {
    const slices = nodeSlices(
      frame(
        ["region1"],
        [
          series("ccgt | power", [4], { techs: "ccgt", carriers: "power" }, "#111111"),
          series("ccgt | heat", [2], { techs: "ccgt", carriers: "heat" }, "#111111"),
          series("pv | power", [9], { techs: "pv", carriers: "power" }, "#222222"),
        ],
      ),
    );
    expect(slices.region1).toEqual([
      { key: "pv", value: 9, color: "#222222" },
      { key: "ccgt", value: 6, color: "#111111" },
    ]);
  });

  it("drops negative and non-finite contributions", () => {
    // A pie is a composition of a whole; a wedge that subtracts from the total
    // cannot be drawn honestly.
    const slices = nodeSlices(
      frame(
        ["region1"],
        [
          series("ccgt", [-5], { techs: "ccgt" }),
          series("pv", [NaN], { techs: "pv" }),
          series("wind", [3], { techs: "wind" }),
        ],
      ),
    );
    expect(slices.region1).toEqual([{ key: "wind", value: 3, color: undefined }]);
  });

  it("omits a node with nothing to show", () => {
    const slices = nodeSlices(
      frame(["region1", "region2"], [series("ccgt", [0, 4], { techs: "ccgt" })]),
    );
    expect(Object.keys(slices)).toEqual(["region2"]);
  });

  it("falls back to the column name when there is no techs dimension", () => {
    const slices = nodeSlices(frame(["region1"], [series("power", [2])]));
    expect(slices.region1[0].key).toBe("power");
  });
});

describe("largestMagnitude and valueExtent", () => {
  it("measures magnitude, not signed value", () => {
    expect(largestMagnitude({ a: -9, b: 4 })).toBe(9);
    expect(largestMagnitude({})).toBe(0);
  });

  it("reports the span for a legend", () => {
    expect(valueExtent({ a: 3, b: -1, c: 7 })).toEqual([-1, 7]);
    expect(valueExtent({})).toBeNull();
  });
});
