import { describe, expect, it } from "vitest";

import { indexToLabel, indexToText, normaliseIndexValue } from "./frameIndex";

describe("normaliseIndexValue", () => {
  it("keeps a Date as a Date", () => {
    const at = new Date("2005-01-01T00:00:00Z");
    expect(normaliseIndexValue(at)).toBe(at);
  });

  it("narrows a bigint to a number", () => {
    expect(normaliseIndexValue(42n)).toBe(42);
    expect(typeof normaliseIndexValue(42n)).toBe("number");
  });

  it("passes numbers and strings through", () => {
    expect(normaliseIndexValue(7)).toBe(7);
    expect(normaliseIndexValue("region1")).toBe("region1");
  });

  it("turns null and undefined into empty text", () => {
    expect(normaliseIndexValue(null)).toBe("");
    expect(normaliseIndexValue(undefined)).toBe("");
  });
});

describe("indexToText", () => {
  it("writes a timestamp in UTC, seconds kept and zone dropped", () => {
    expect(indexToText(new Date("2005-01-01T00:00:00Z"))).toBe("2005-01-01T00:00:00");
    expect(indexToText(new Date("2005-07-14T13:45:09Z"))).toBe("2005-07-14T13:45:09");
  });

  it("does not shift a timestamp into the viewer's timezone", () => {
    // The instant Arrow hands back is what Calliope wrote; reading it with local
    // getters would move every timestep by the browser's offset.
    const at = new Date(Date.UTC(2005, 0, 1, 23, 0, 0));
    expect(indexToText(at)).toBe("2005-01-01T23:00:00");
  });

  it("pads a year below four digits rather than truncating it", () => {
    expect(indexToText(new Date(Date.UTC(999, 0, 1)))).toBe("0999-01-01T00:00:00");
  });

  it("writes a period index as its number", () => {
    expect(indexToText(0)).toBe("0");
    expect(indexToText(8759n)).toBe("8759");
  });

  it("writes a category index as itself", () => {
    expect(indexToText("region1")).toBe("region1");
  });
});

describe("indexToLabel", () => {
  const labels = { region1_to_region2: "region1 → region2" };

  it("relabels a technology index", () => {
    expect(indexToLabel("region1_to_region2", "techs", labels)).toBe("region1 → region2");
  });

  it("leaves a technology with no label alone", () => {
    expect(indexToLabel("ccgt", "techs", labels)).toBe("ccgt");
  });

  it("does not relabel a node that shares a technology's name", () => {
    expect(indexToLabel("region1_to_region2", "nodes", labels)).toBe(
      "region1_to_region2",
    );
  });
});
