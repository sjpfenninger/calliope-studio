import { describe, expect, it } from "vitest";

import {
  linkToRaw,
  nodeToRaw,
  rawToLink,
  rawToNode,
  rawToTech,
  techToRaw,
} from "./entries";

/**
 * The marshalling between a YAML entry and the form that edits it.
 *
 * The most consequential untested code in the repository until now: this is
 * where a bug quietly rewrites a user's model, and it produces no error when it
 * does. The cases below are all things a naive implementation gets wrong in a
 * way nobody notices until a run behaves differently from the file.
 */
describe("techs", () => {
  it("round-trips an entry losing nothing", () => {
    const raw = {
      name: "Combined cycle gas turbine",
      base_tech: "supply",
      carrier_out: "power",
      flow_cap_max: 40000,
      lifetime: 25,
    };
    expect(techToRaw(rawToTech("ccgt", raw))).toEqual(raw);
  });

  it("keeps a parameter it has no field for", () => {
    // A technology may carry any parameter at all — the form knows four of them
    // and must not be the reason the rest disappear.
    const raw = { some_future_parameter: 7 };
    expect(techToRaw(rawToTech("x", raw))).toEqual(raw);
  });

  it("writes active: false but not active: true", () => {
    // Absent means active, so writing the default would add a line to every
    // entry in the file on the first save.
    expect(techToRaw(rawToTech("x", { active: false }))).toEqual({ active: false });
    expect(techToRaw(rawToTech("x", { active: true }))).toEqual({});
  });

  it("keeps a template, and the base_tech that overrides it", () => {
    const raw = { template: "cost_dim_setter", base_tech: "supply" };
    expect(techToRaw(rawToTech("x", raw))).toEqual(raw);
  });

  it("drops an emptied value rather than writing an empty string", () => {
    // `flow_cap_max: ""` is a value Calliope would try to read as a number.
    const entry = rawToTech("x", { flow_cap_max: 100 });
    entry.extraParams[0].value = "";
    expect(techToRaw(entry)).toEqual({});
  });

  it("drops a parameter with no name", () => {
    const entry = rawToTech("x", {});
    entry.extraParams.push({ key: "", value: 5 });
    expect(techToRaw(entry)).toEqual({});
  });

  it("keeps a zero, which is a value and not an absence", () => {
    expect(techToRaw(rawToTech("x", { flow_out_eff: 0 }))).toEqual({ flow_out_eff: 0 });
  });

  it("keeps an indexed parameter whole", () => {
    // Splitting `{data, index, dims}` would let the parts drift apart.
    const raw = { cost_flow_cap: { data: 100, index: "monetary", dims: "costs" } };
    expect(techToRaw(rawToTech("x", raw))).toEqual(raw);
  });

  it("reads a missing entry as an empty one", () => {
    expect(rawToTech("x", null)).toMatchObject({ name: "x", active: true });
  });
});

describe("links", () => {
  it("round-trips a link, endpoints and all", () => {
    const raw = {
      link_from: "region1",
      link_to: "region2",
      base_tech: "transmission",
      flow_cap_max: 10000,
    };
    expect(linkToRaw(rawToLink("r1_to_r2", raw))).toEqual(raw);
  });

  it("does not add a base_tech to a link that inherits one", () => {
    // `base_tech` almost always comes from the template; writing it here would
    // add a redundant line to every templated link in the file. Whether it does
    // is now *checked* against the resolved templates rather than assumed.
    const raw = { template: "free_transmission", link_from: "a", link_to: "b" };
    const templates = { free_transmission: { base_tech: "transmission" } };
    expect(linkToRaw(rawToLink("x", raw), templates)).toEqual(raw);
  });

  it("declares base_tech when the template does not supply one", () => {
    // A template that only sets costs makes a link that Calliope does not treat
    // as transmission at all. Assuming any template supplies `base_tech` is what
    // let the map's add-link flow write one.
    const raw = { template: "interest_rate_setter", link_from: "a", link_to: "b" };
    const templates = { interest_rate_setter: { cost_interest_rate: 0.07 } };
    expect(linkToRaw(rawToLink("x", raw), templates)).toMatchObject({
      base_tech: "transmission",
    });
  });

  it("declares base_tech for a template it has never heard of", () => {
    // A typo, or a template in a file that could not be read. A redundant key is
    // noise; a missing one is a broken model.
    const raw = { template: "who_knows", link_from: "a", link_to: "b" };
    expect(linkToRaw(rawToLink("x", raw))).toMatchObject({
      base_tech: "transmission",
    });
  });

  it("declares base_tech for a link that has no template", () => {
    // Without it the entry is not a transmission technology at all, and the
    // links editor would stop recognising its own entry after a save.
    expect(linkToRaw(rawToLink("x", { link_from: "a", link_to: "b" }))).toMatchObject({
      base_tech: "transmission",
    });
  });

  it("keeps the endpoints out of the parameter list", () => {
    const entry = rawToLink("x", { link_from: "a", link_to: "b", flow_cap_max: 1 });
    expect(entry.params.map((param) => param.key)).toEqual(["flow_cap_max"]);
  });

  it("omits an endpoint that has not been filled in", () => {
    // Half a link is not a link, and `link_to: ""` fails at build time with a
    // message about an empty node name.
    expect(linkToRaw(rawToLink("x", { link_from: "a" }))).not.toHaveProperty("link_to");
  });
});

describe("nodes", () => {
  it("round-trips a node with coordinates and technologies", () => {
    const raw = {
      latitude: 40,
      longitude: -2,
      techs: { demand_power: null, ccgt: { flow_cap_max: 30000 } },
    };
    expect(nodeToRaw(rawToNode("region1", raw))).toEqual(raw);
  });

  it("keeps a technology that overrides nothing", () => {
    // `demand_power:` with nothing under it says "this node has this
    // technology, as defined" — writing `{}` instead changes what Calliope
    // reads, and dropping it removes the technology from the node.
    expect(nodeToRaw(rawToNode("x", { techs: { demand_power: null } }))).toEqual({
      techs: { demand_power: null },
    });
  });

  it("omits the techs block entirely when there are none", () => {
    expect(nodeToRaw(rawToNode("x", {}))).toEqual({});
  });

  it("keeps a latitude of zero", () => {
    // The equator is a real place, and `if (latitude)` puts it in the sea.
    expect(nodeToRaw(rawToNode("x", { latitude: 0, longitude: 0 }))).toEqual({
      latitude: 0,
      longitude: 0,
    });
  });

  it("omits a coordinate that is not set", () => {
    expect(nodeToRaw(rawToNode("x", {}))).not.toHaveProperty("latitude");
  });

  it("keeps unrecognised node parameters", () => {
    const raw = { available_area: 100000 };
    expect(nodeToRaw(rawToNode("x", raw))).toEqual(raw);
  });

  it("drops a technology with no name", () => {
    const entry = rawToNode("x", {});
    entry.techs.push({ techName: "", params: [{ key: "a", value: 1 }] });
    expect(nodeToRaw(entry)).toEqual({});
  });
});
