import { describe, expect, it } from "vitest";
import { reactive } from "vue";

import {
  duplicateNameError,
  duplicateNames,
  parseScalarList,
  linkToRaw,
  nodeToRaw,
  rawToLink,
  rawToNode,
  parseScalar,
  rawToTech,
  loadedName,
  rememberName,
  renamesFor,
  rowKey,
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

/**
 * The one place the app decides whether a typed value is a number.
 *
 * Its own docstring says a second copy of this is how `.inf` came to be deleted
 * from people's files once already, and it had no test at all. `Number(".inf")`
 * is `NaN`, which is exactly what keeps the YAML spelling a string all the way
 * back to `yaml_io.from_plain` — so these cases are the frontend half of an
 * invariant `tests/test_yaml_io.py` pins four times on the Python side.
 */
describe("parseScalar", () => {
  it.each([".inf", "-.inf", ".nan"])("leaves the YAML spelling %s alone", (raw) => {
    expect(parseScalar(raw)).toBe(raw);
  });

  it.each([
    ["100", 100],
    ["0.5", 0.5],
    ["1e6", 1000000],
    ["-3", -3],
    ["  42  ", 42],
  ])("reads %s as the number %s", (raw, expected) => {
    expect(parseScalar(raw as string)).toBe(expected);
  });

  it.each(["", "   "])("reads %o as unset, which drops the key", (raw) => {
    expect(parseScalar(raw)).toBeNull();
  });

  it.each(["power", "monetary", "2005-01-01", "1,2"])(
    "keeps %s as text",
    (raw) => {
      expect(parseScalar(raw)).toBe(raw);
    },
  );

  it("does not read a boolean spelling as anything but text", () => {
    expect(parseScalar("true")).toBe("true");
  });

  it.each(["Infinity", "-Infinity", "1e999", "NaN", "0x1A", "0b11", "0o17"])(
    "keeps %s as text, since JSON could not carry what Number() makes of it",
    (raw) => {
      expect(parseScalar(raw)).toBe(raw);
    },
  );
});

describe("parseScalarList", () => {
  it("reads each item like parseScalar", () => {
    expect(parseScalarList("100, 200")).toEqual([100, 200]);
    expect(parseScalarList("electricity, heat")).toEqual(["electricity", "heat"]);
  });

  it("drops empty items", () => {
    expect(parseScalarList(" , a,, ")).toEqual(["a"]);
    expect(parseScalarList("")).toEqual([]);
  });
});

/**
 * A parameter row has no name to key on, so the lists were keyed by index — and
 * removing a row made Vue reuse the component that had been showing the row
 * above it, which reads its value once at setup. The previous row's value then
 * sat under the new row's key, and the next change wrote it there.
 *
 * The entry lists now key on this too, for the mirror-image reason: they keyed
 * on the entry's *name*, which is the one field the form lets you change, so
 * every keystroke in a name box remounted the row being typed in.
 */
describe("rowKey", () => {
  it("is stable for one row across calls", () => {
    const row = { key: "flow_cap_max", value: 100 };
    expect(rowKey(row)).toBe(rowKey(row));
  });

  it("distinguishes two rows with identical contents", () => {
    const a = { key: "flow_cap_max", value: 100 };
    const b = { key: "flow_cap_max", value: 100 };
    expect(rowKey(a)).not.toBe(rowKey(b));
  });

  it("survives the row moving, which is the whole point", () => {
    const rows = [
      { key: "a", value: 1 },
      { key: "b", value: 2 },
    ];
    const second = rowKey(rows[1]);
    rows.splice(0, 1);
    expect(rowKey(rows[0])).toBe(second);
  });

  it("does not change when the entry is renamed", () => {
    // The bug this replaced `entryKey` for. A name key changes per character,
    // so Vue unmounted the accordion row mid-word: focus went to the document
    // and the row collapsed, making a five-letter name five clicks of work.
    const entry = { name: "" };
    const before = rowKey(entry);
    entry.name = "solar_x";
    expect(rowKey(entry)).toBe(before);
  });

  it("distinguishes two entries that share a name", () => {
    // Which a file cannot contain, but a form mid-edit certainly can: two rows
    // both called `(unnamed)` are what "Add tech" twice produces.
    const a = { name: "" };
    const b = { name: "" };
    expect(rowKey(a)).not.toBe(rowKey(b));
  });

  it("is the same through a Vue reactive proxy as the template sees it", () => {
    // The editors call this on `entries.value[i]`, which is a proxy rather than
    // the object pushed in. Vue hands out one proxy per raw object, so the
    // WeakMap keys on a stable identity — but the whole scheme rests on that,
    // so it is asserted rather than assumed.
    const list = reactive([{ name: "ccgt" }]);
    expect(rowKey(list[0])).toBe(rowKey(list[0]));
    const captured = list[0];
    list[0].name = "renamed";
    expect(rowKey(captured)).toBe(rowKey(list[0]));
  });
});

describe("renamesFor", () => {
  // What the server is told beside the section. A rename it is not told about
  // is a deletion and an addition: the entry goes to the end of the file and
  // its comments go with the deleted key.
  function loaded(...names: string[]) {
    const rows = reactive(names.map((name) => ({ name })));
    for (const row of rows) rememberName(row, row.name);
    return rows;
  }

  it("reports nothing for rows still called what they were loaded as", () => {
    expect(renamesFor(loaded("ccgt", "battery"))).toEqual({});
  });

  it("maps a new name to the one it was loaded under", () => {
    const rows = loaded("ccgt", "battery");
    rows[0]!.name = "gas";
    expect(renamesFor(rows)).toEqual({ gas: "ccgt" });
    expect(loadedName(rows[0]!)).toBe("ccgt");
  });

  it("reports a swap as two renames", () => {
    const rows = loaded("ccgt", "battery");
    rows[0]!.name = "battery";
    rows[1]!.name = "ccgt";
    expect(renamesFor(rows)).toEqual({ battery: "ccgt", ccgt: "battery" });
  });

  it("treats a row added this session as an addition, not a rename", () => {
    const rows = loaded("ccgt");
    rows.push({ name: "solar" });
    expect(renamesFor(rows)).toEqual({});
  });

  it("says nothing about a row renamed to nothing, or back to its own name", () => {
    // A blank name is a row the payload drops, not a rename; a name typed
    // back to what it was is no change at all.
    const rows = loaded("ccgt", "battery");
    rows[0]!.name = "";
    rows[1]!.name = "cell";
    rows[1]!.name = "battery";
    expect(renamesFor(rows)).toEqual({});
  });

  it("measures a later rename from the name the last save wrote", () => {
    const rows = loaded("ccgt");
    rows[0]!.name = "gas";
    rememberName(rows[0]!, rows[0]!.name);
    rows[0]!.name = "gas_turbine";
    expect(renamesFor(rows)).toEqual({ gas_turbine: "gas" });
  });
});

describe("duplicateNames", () => {
  // Two rows under one name fold into one payload key, and the server reads
  // a rename onto a name the payload dropped as the deletion it is — so the
  // editors have to refuse before the two rows become one.
  it("names each repeated name once, in order of first repeat", () => {
    const rows = [{ name: "a" }, { name: "b" }, { name: "a" }, { name: "b" }, { name: "a" }];
    expect(duplicateNames(rows)).toEqual(["a", "b"]);
  });

  it("ignores rows still unnamed", () => {
    expect(duplicateNames([{ name: "" }, { name: "" }, { name: "x" }])).toEqual([]);
  });

  it("wraps the first one in an error a save can show", () => {
    expect(duplicateNameError(["ccgt"], "technologies").message).toContain("“ccgt”");
  });
});
