import { describe, expect, it } from "vitest";

import type { ResultFrame, Series } from "../api/results";
import { csvFilename, frameToCsv } from "./frameCsv";

function series(key: string, dims: Record<string, string>, values: number[]): Series {
  return { key, dims, values: Float64Array.from(values) };
}

function frame(overrides: Partial<ResultFrame> = {}): ResultFrame {
  return {
    index: ["2005-01-01T00:00:00", "2005-01-01T01:00:00"],
    indexName: "timesteps",
    indexIsTime: false,
    series: [series("ccgt", { techs: "ccgt" }, [1, 2])],
    variable: "flow_cap",
    order: "time",
    seriesDims: ["techs"],
    ...overrides,
  };
}

/** What a real timesteps column looks like: epoch milliseconds, as numbers. */
const EPOCH = [1104537600000, 1104541200000];

const LINES = (csv: string) => csv.trimEnd().split("\n");

describe("frameToCsv", () => {
  it("writes the index name and one column per series", () => {
    const csv = frameToCsv([{ frame: frame() }]);
    expect(LINES(csv)).toEqual([
      "timesteps,ccgt",
      "2005-01-01T00:00:00,1",
      "2005-01-01T01:00:00,2",
    ]);
  });

  it("ends with a newline", () => {
    expect(frameToCsv([{ frame: frame() }]).endsWith("\n")).toBe(true);
  });

  it("names a link column by its endpoints, as the legend does", () => {
    const csv = frameToCsv(
      [
        {
          frame: frame({
            series: [series("region1_to_region2", { techs: "region1_to_region2" }, [1, 2])],
          }),
        },
      ],
      { region1_to_region2: "region1 → region2" },
    );
    expect(LINES(csv)[0]).toBe("timesteps,region1 → region2");
  });

  it("relabels a technology index too, so the file matches the grid", () => {
    const csv = frameToCsv(
      [
        {
          frame: frame({
            index: ["region1_to_region2", "ccgt"],
            indexName: "techs",
            series: [series("value", {}, [1, 2])],
            seriesDims: [],
          }),
        },
      ],
      { region1_to_region2: "region1 → region2" },
    );
    expect(LINES(csv)).toEqual(["techs,value", "region1 → region2,1", "ccgt,2"]);
  });

  it("writes a timestamp column as ISO, not as epoch milliseconds", () => {
    const csv = frameToCsv([
      { frame: frame({ index: EPOCH, indexIsTime: true }) },
    ]);
    expect(LINES(csv)).toEqual([
      "timesteps,ccgt",
      "2005-01-01T00:00:00,1",
      "2005-01-01T01:00:00,2",
    ]);
  });

  it("joins two timestamp frames on the instant, not on the raw value", () => {
    const asNumbers = frame({ index: EPOCH, indexIsTime: true });
    const asDates = frame({
      index: EPOCH.map((ms) => new Date(ms)),
      indexIsTime: true,
      series: [series("csp", { techs: "csp" }, [3, 4])],
    });
    const csv = frameToCsv([
      { label: "a", frame: asNumbers },
      { label: "b", frame: asDates },
    ]);
    // Two rows, not four: the same instant written two ways is one row.
    expect(LINES(csv)).toEqual([
      "timesteps,a · ccgt,b · csp",
      "2005-01-01T00:00:00,1,3",
      "2005-01-01T01:00:00,2,4",
    ]);
  });

  it("writes NaN as an empty field, not the text NaN", () => {
    const csv = frameToCsv([
      { frame: frame({ series: [series("ccgt", { techs: "ccgt" }, [NaN, 2])] }) },
    ]);
    expect(LINES(csv)[1]).toBe("2005-01-01T00:00:00,");
  });

  it("never locale-formats a number", () => {
    // Under a European locale `toLocaleString` gives `1.234,5`, and that comma
    // would take the column count apart.
    const csv = frameToCsv([
      { frame: frame({ series: [series("ccgt", { techs: "ccgt" }, [1234.5, 1e7])] }) },
    ]);
    expect(LINES(csv)[1]).toBe("2005-01-01T00:00:00,1234.5");
    expect(LINES(csv)[2]).toBe("2005-01-01T01:00:00,10000000");
  });

  it("keeps full precision rather than rounding for readability", () => {
    const value = 0.1 + 0.2;
    const csv = frameToCsv([
      { frame: frame({ series: [series("ccgt", { techs: "ccgt" }, [value, 0])] }) },
    ]);
    expect(LINES(csv)[1]).toBe(`2005-01-01T00:00:00,${String(value)}`);
  });

  it("quotes a field containing the delimiter, and doubles inner quotes", () => {
    const csv = frameToCsv([
      {
        frame: frame({
          index: ["north, west"],
          indexName: "nodes",
          series: [series('say "hi"', { techs: 'say "hi"' }, [1])],
          seriesDims: ["techs"],
        }),
      },
    ]);
    expect(LINES(csv)).toEqual(['nodes,"say ""hi"""', '"north, west",1']);
  });

  it("writes a duration curve's period index and padding", () => {
    const csv = frameToCsv([
      {
        frame: frame({
          index: [0, 1, 2],
          indexName: "period",
          order: "duration",
          series: [series("ccgt", { techs: "ccgt" }, [9, 4, NaN])],
        }),
      },
    ]);
    expect(LINES(csv)).toEqual(["period,ccgt", "0,9", "1,4", "2,"]);
  });

  it("joins several sources on their shared index, prefixing the columns", () => {
    const size = frame({
      index: ["region1", "region2"],
      indexName: "nodes",
      series: [series("value", {}, [10, 20])],
      seriesDims: [],
    });
    const colour = frame({
      index: ["region2", "region3"],
      indexName: "nodes",
      series: [series("value", {}, [5, 6])],
      seriesDims: [],
    });

    const csv = frameToCsv([
      { label: "flow_cap", frame: size },
      { label: "storage_cap", frame: colour },
    ]);

    // region3 appears only in the second source and must not be dropped.
    expect(LINES(csv)).toEqual([
      "nodes,flow_cap · value,storage_cap · value",
      "region1,10,",
      "region2,20,5",
      "region3,,6",
    ]);
  });

  it("does not prefix a single source", () => {
    const csv = frameToCsv([{ label: "flow_cap", frame: frame() }]);
    expect(LINES(csv)[0]).toBe("timesteps,ccgt");
  });

  it("returns nothing at all for no frames, a null frame or an empty one", () => {
    expect(frameToCsv([])).toBe("");
    expect(frameToCsv([{ frame: null }])).toBe("");
    expect(frameToCsv([{ frame: frame({ series: [] }) }])).toBe("");
  });

  it("skips an empty source among several", () => {
    const csv = frameToCsv([
      { label: "a", frame: null },
      { label: "b", frame: frame() },
    ]);
    // One source survives, so nothing is prefixed.
    expect(LINES(csv)[0]).toBe("timesteps,ccgt");
  });
});

describe("csvFilename", () => {
  it("joins the model name and the variable", () => {
    expect(csvFilename("national_scale", "flow_cap")).toBe(
      "national_scale-flow_cap.csv",
    );
  });

  it("strips anything that would read as a path", () => {
    expect(csvFilename("a/b\\c", "flow*")).toBe("a-b-c-flow-.csv");
  });

  it("falls back when the model has no name", () => {
    expect(csvFilename(null, "flow_cap")).toBe("results-flow_cap.csv");
  });
});
