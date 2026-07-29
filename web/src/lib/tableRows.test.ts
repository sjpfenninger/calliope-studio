import { describe, expect, it } from "vitest";

import type { ResultFrame, Series } from "../api/results";
import { frameToGrid } from "./tableRows";

function series(key: string, dims: Record<string, string>, values: number[]): Series {
  return { key, dims, values: Float64Array.from(values) };
}

function frame(overrides: Partial<ResultFrame> = {}): ResultFrame {
  return {
    index: ["2005-01-01T00:00:00", "2005-01-01T01:00:00"],
    indexName: "timesteps",
    indexIsTime: false,
    series: [series("region1 | ccgt", { nodes: "region1", techs: "ccgt" }, [1, 2])],
    variable: "flow_cap",
    order: "time",
    seriesDims: ["nodes", "techs"],
    unit: null,
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

  it("names the unit on every series column, but not on the index", () => {
    const { columns } = frameToGrid(frame(), {}, { factor: 0.001, label: "GWh" });
    expect(columns[0].headerName).toBe("timesteps");
    // On each column rather than once above them, because that is what the CSV
    // can say — and the cells hold the scaled number, so a header without it
    // would be wrong rather than merely terse.
    expect(columns[1].headerName).toBe("region1 | ccgt (GWh)");
  });

  it("says nothing when there is no unit to name", () => {
    const { columns } = frameToGrid(frame(), {}, { factor: 1, label: "" });
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

  it("shows a timestamp column as ISO, exactly as the CSV writes it", () => {
    const { rows } = frameToGrid(
      frame({ index: [1104537600000, 1104541200000], indexIsTime: true }),
    );
    expect(rows.map((row) => row.c0)).toEqual([
      "2005-01-01T00:00:00",
      "2005-01-01T01:00:00",
    ]);
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

  /**
   * The formatter itself is `lib/precision.ts`'s, tested there. What matters
   * here is that the column reaches for it with the reader's precision, since a
   * grid that ignored the setting would look exactly like the setting doing
   * nothing.
   */
  it("formats a cell at the precision it is given", () => {
    const format = (precision: number | null) => {
      const { columns } = frameToGrid(frame(), {}, null, precision);
      return columns[1].valueFormatter as (params: { value: unknown }) => string;
    };
    expect(format(3)({ value: 1234.5678 })).toBe("1230");
    expect(format(null)({ value: 1234.5678 })).toBe("1234.5678");
  });
});
