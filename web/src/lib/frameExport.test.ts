import { beforeEach, describe, expect, it, vi } from "vitest";

// `saveText` opens a real file picker and, failing that, clicks an anchor and
// creates an object URL. Neither is the subject here: what is under test is what
// gets handed to it, and how many times.
vi.mock("./download", () => ({ saveText: vi.fn(async () => true) }));

import type { ResultFrame, Series } from "../api/results";
import { saveText } from "./download";
import type { CsvSource } from "./frameCsv";
import { exportFrames, hasData } from "./frameExport";

const saved = vi.mocked(saveText);

function series(key: string, dims: Record<string, string>, values: number[]): Series {
  return { key, dims, values: Float64Array.from(values) };
}

function frame(overrides: Partial<ResultFrame> = {}): ResultFrame {
  return {
    index: ["2005-01-01T00:00:00", "2005-01-01T01:00:00"],
    indexName: "timesteps",
    indexIsTime: false,
    series: [series("ccgt", { techs: "ccgt" }, [1.23456789, 2])],
    variable: "flow_cap",
    order: "time",
    seriesDims: ["techs"],
    unit: null,
    ...overrides,
  };
}

/** The single call's arguments: the filename it chose, and the text it wrote. */
function onlyCall(): { filename: string; csv: string } {
  expect(saved).toHaveBeenCalledOnce();
  const [filename, csv] = saved.mock.calls[0];
  return { filename, csv };
}

/**
 * The export button, which writes the figure rather than re-asking for it.
 *
 * The frame the chart is holding is already selector-narrowed, resampled,
 * summed, zero-stripped and — in Duration — sorted per series. Fetching afresh
 * would be a second answer: the selection may have moved since the button was
 * drawn, and then the file is not the picture it was taken from. It is also why
 * the CSV is built synchronously, before anything is awaited, since the picker
 * needs the click's user gesture still to be live.
 */
describe("exportFrames", () => {
  beforeEach(() => saved.mockClear());

  it("writes one file per figure, however many frames the figure draws", () => {
    // The map draws three channels at once. Three files would be three saves to
    // place and then join by hand; they share an index, so they are columns.
    exportFrames(
      [
        { label: "size", frame: frame() },
        {
          label: "colour",
          frame: frame({ series: [series("csp", { techs: "csp" }, [7, 8])] }),
        },
      ],
      "flow_cap",
      "national",
      {},
    );
    const { csv } = onlyCall();
    expect(csv.split("\n")[0]).toBe("timesteps,size · ccgt,colour · csp");
  });

  it("names the file after the model and the variable", () => {
    exportFrames([{ frame: frame() }], "flow_cap", "national_scale", {});
    expect(onlyCall().filename).toBe("national_scale-flow_cap.csv");
  });

  it("still names a file when the model does not name itself", () => {
    // A results handle opened directly may have no model name, and a download
    // called `-flow_cap.csv` or `undefined-flow_cap.csv` is one the user then
    // has to rename.
    for (const model of [null, undefined, ""]) {
      saved.mockClear();
      exportFrames([{ frame: frame() }], "flow_cap", model, {});
      expect(onlyCall().filename).toBe("results-flow_cap.csv");
    }
  });

  it("writes every digit by default", () => {
    // The default is the whole point: the file is the artefact somebody is
    // about to do arithmetic on, so trimming it would be a silent, unasked-for
    // loss. Rounding is opt-in, in one place, and never a side effect of the
    // grid being formatted for reading.
    exportFrames([{ frame: frame() }], "flow_cap", "m", {});
    expect(onlyCall().csv).toContain("1.23456789");
  });

  it("applies the precision it is given, which is the export one", () => {
    // The parameter is named for the mistake it exists to prevent: passing the
    // *display* precision here would round every download for a user who only
    // asked for a readable table, and they would have no way to tell.
    exportFrames([{ frame: frame() }], "flow_cap", "m", {}, 3);
    const { csv } = onlyCall();
    expect(csv).toContain("1.23");
    expect(csv).not.toContain("1.23456789");
  });

  it("labels a column exactly as its legend entry reads", () => {
    exportFrames([{ frame: frame() }], "flow_cap", "m", { ccgt: "Combined cycle" });
    expect(onlyCall().csv.split("\n")[0]).toBe("timesteps,Combined cycle");
  });

  it("writes nothing at all rather than a file with only a header", () => {
    // An empty CSV lands in the user's chosen location as a file that looks
    // like a successful export and contains nothing. Better that the button
    // does nothing visible than that it produces a misleading artefact.
    for (const sources of [
      [] as CsvSource[],
      [{ frame: null }],
      [{ frame: frame({ series: [] }) }],
    ]) {
      exportFrames(sources, "flow_cap", "m", {});
    }
    expect(saved).not.toHaveBeenCalled();
  });
});

describe("hasData", () => {
  it("is false for a frame that has not arrived", () => {
    // This is what disables the export button, so it has to be false during the
    // ordinary loading state and not merely for an error.
    expect(hasData(null)).toBe(false);
  });

  it("is false for a frame with no series", () => {
    // `drop_zeros` can empty a frame server-side: a real response, a real index,
    // and nothing to write. Offering an export for it produces the header-only
    // file above.
    expect(hasData(frame({ series: [] }))).toBe(false);
  });

  it("is true as soon as there is a series", () => {
    // Series, not index: a streamed frame's columns are what the chart paints,
    // and an index alone draws nothing.
    expect(hasData(frame())).toBe(true);
    expect(hasData(frame({ index: [] }))).toBe(true);
  });
});
