import { describe, expect, it } from "vitest";

import { seriesLabel } from "./seriesLabel";
import type { Series } from "../api/results";

function series(key: string, dims: Record<string, string>): Series {
  return { key, values: new Float64Array(), dims };
}

const LABELS = { r1_to_r2: "r1 → r2" };

describe("seriesLabel", () => {
  it("labels a link by its endpoints", () => {
    expect(
      seriesLabel(series("r1_to_r2", { techs: "r1_to_r2" }), ["techs"], LABELS),
    ).toBe("r1 → r2");
  });

  it("leaves the other parts of a compound name alone", () => {
    // The node happens to be called the same as the link; only the technology
    // component may be substituted.
    const compound = series("r1_to_r2 | r1_to_r2", {
      nodes: "r1_to_r2",
      techs: "r1_to_r2",
    });
    expect(seriesLabel(compound, ["nodes", "techs"], LABELS)).toBe(
      "r1_to_r2 | r1 → r2",
    );
  });

  it("keeps a technology that has no label", () => {
    expect(seriesLabel(series("ccgt", { techs: "ccgt" }), ["techs"], LABELS)).toBe(
      "ccgt",
    );
  });

  it("uses the server's own name when there is no technology to relabel", () => {
    // `sum_by: "techs"` leaves one series per node, and a fully reduced frame has
    // no series dimensions at all.
    expect(seriesLabel(series("region1", { nodes: "region1" }), ["nodes"], LABELS)).toBe(
      "region1",
    );
    expect(seriesLabel(series("value", {}), [], LABELS)).toBe("value");
  });

  it("falls back rather than producing an empty name", () => {
    // A dimension the metadata does not carry must not blank the legend entry.
    expect(seriesLabel(series("value", {}), ["techs"], LABELS)).toBe("value");
  });
});
