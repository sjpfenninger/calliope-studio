import { describe, expect, it } from "vitest";

import { describeParam, describeParams, paramSources } from "./dataTableParams";

/**
 * A data table's contribution to one entity, as the editor shows it.
 *
 * The case that matters is a parameter indexed on more than the entity. The reader
 * used to collapse those onto the entity dimension and present a value, so node
 * `NLD111` was told it had `flow_cap_max = 0.0058` — a `(nodes, techs)` parameter,
 * valued from whichever technology's row came last.
 */

describe("describeParam", () => {
  it("shows a plain value", () => {
    expect(
      describeParam({ value: 53.1, time_varying: false, source: "nodes", dims: [] }),
    ).toBe("53.1");
  });

  it("qualifies a value by its single-member dimension", () => {
    // One cost class is the common case, and the number is unambiguous — but it
    // is the *monetary* one, and saying so costs nothing.
    expect(
      describeParam({
        value: 1000,
        time_varying: false,
        source: "cost_parameters",
        dims: ["costs"],
        index: { costs: "monetary" },
      }),
    ).toBe("1000 (monetary)");
  });

  it("names the dimensions instead of inventing a value", () => {
    expect(
      describeParam({
        value: null,
        time_varying: false,
        source: "flow_cap_max",
        dims: ["techs"],
      }),
    ).toBe("per techs");
  });

  it("says a timeseries is a timeseries", () => {
    expect(
      describeParam({
        value: null,
        time_varying: true,
        source: "demand",
        dims: ["timesteps"],
      }),
    ).toBe("time-varying");
  });

  it("and what else it is indexed by", () => {
    expect(
      describeParam({
        value: null,
        time_varying: true,
        source: "demand",
        dims: ["techs", "timesteps"],
      }),
    ).toBe("time-varying, per techs");
  });

  it("copes with a server that reports no dims at all", () => {
    expect(describeParam({ value: 7, time_varying: false, source: "x" })).toBe("7");
  });
});

describe("describeParams", () => {
  const params = {
    latitude: { value: 53.1, time_varying: false, source: "nodes", dims: [] },
    flow_cap_max: {
      value: null,
      time_varying: false,
      source: "flow_cap_max",
      dims: ["techs"],
    },
  };

  it("describes every parameter", () => {
    expect(describeParams(params)).toEqual({
      latitude: "53.1",
      flow_cap_max: "per techs",
    });
  });

  it("names the table each came from", () => {
    expect(paramSources(params)).toEqual({
      latitude: "nodes",
      flow_cap_max: "flow_cap_max",
    });
  });

  it("copes with an entity no table mentions", () => {
    expect(describeParams(undefined)).toEqual({});
    expect(paramSources(undefined)).toEqual({});
  });
});
