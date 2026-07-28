import { describe, expect, it } from "vitest";

import type { ResultFrame, Series } from "../api/results";
import { formatCell, frameToGrid } from "./tableRows";

function series(key: string, dims: Record<string, string>, values: number[]): Series {
  return { key, dims, values: Float64Array.from(values) };
}

function frame(overrides: Partial<ResultFrame> = {}): ResultFrame {
  return {
    index: ["2005-01-01T00:00:00", "2005-01-01T01:00:00"],
    indexName: "timesteps",
    series: [series("region1 | ccgt", { nodes: "region1", techs: "ccgt" }, [1, 2])],
    variable: "flow_cap",
    order: "time",
    seriesDims: ["nodes", "techs"],
    ...overrides,
  };
}

describe("frameToGrid", () => {
  it("keys columns positionally, never by the series name", () => {
    const { columns } = frameToGrid(frame());
    expect(columns.map((column) => column.field)).toEqual(["c0", "c1"]);
    // The series key is full of spaces and separators; AG Grid would read it as
    // a path expression.
    expect(columns[1].field).not.toContain("|");
  });

  it("puts the label in headerName", () => {
    const { columns } = frameToGrid(frame());
    expect(columns[0].headerName).toBe("timesteps");
    expect(columns[1].headerName).toBe("region1 | ccgt");
  });

  it("names a link column by its endpoints", () => {
    const { columns } = frameToGrid(
      frame({
        series: [
          series("region1 | region1_to_region2", {
            nodes: "region1",
            techs: "region1_to_region2",
          }, [1, 2]),
        ],
      }),
      { region1_to_region2: "region1 → region2" },
    );
    expect(columns[1].headerName).toBe("region1 | region1 → region2");
  });

  it("relabels a technology index", () => {
    const { rows } = frameToGrid(
      frame({
        index: ["region1_to_region2"],
        indexName: "techs",
        series: [series("value", {}, [1])],
        seriesDims: [],
      }),
      { region1_to_region2: "region1 → region2" },
    );
    expect(rows[0].c0).toBe("region1 → region2");
  });

  it("puts the raw number in the row and leaves formatting to the column", () => {
    const { rows } = frameToGrid(frame());
    expect(rows).toEqual([
      { c0: "2005-01-01T00:00:00", c1: 1 },
      { c0: "2005-01-01T01:00:00", c1: 2 },
    ]);
  });

  it("writes a gap as undefined rather than NaN, so sorting still works", () => {
    const { rows } = frameToGrid(
      frame({ series: [series("ccgt", { techs: "ccgt" }, [NaN, 2])] }),
    );
    expect(rows[0].c1).toBeUndefined();
    expect(rows[1].c1).toBe(2);
  });

  it("gives nothing for a null or empty frame", () => {
    expect(frameToGrid(null)).toEqual({ columns: [], rows: [] });
    expect(frameToGrid(frame({ series: [] }))).toEqual({ columns: [], rows: [] });
  });
});

describe("formatCell", () => {
  it("trims the noise a float sum leaves behind", () => {
    expect(formatCell(0.1 + 0.2)).toBe("0.3");
  });

  it("keeps an ordinary value as it is", () => {
    expect(formatCell(1234.5)).toBe("1234.5");
    expect(formatCell(0)).toBe("0");
  });

  it("goes exponential at the ends of the scale", () => {
    expect(formatCell(1e10)).toBe("1.0000e+10");
    expect(formatCell(1.31e-8)).toBe("1.3100e-8");
  });

  it("shows nothing for a gap", () => {
    expect(formatCell(undefined)).toBe("");
    expect(formatCell(NaN)).toBe("");
  });
});
