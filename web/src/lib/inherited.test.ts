import { describe, expect, it } from "vitest";

import {
  collectInherited,
  linkSetsKey,
  nodeSetsKey,
  techSetsKey,
  unmatchedInherited,
} from "./inherited";
import { rawToLink, rawToNode, rawToTech } from "./entries";

/**
 * What a field shows as its ghost value, and whether it offers to revert.
 *
 * Both of those write to a user's model — the revert clears a key out of their
 * file — so neither may be inferred by eye from a `<script setup>` block.
 */

describe("collectInherited", () => {
  const table = {
    latitude: { value: 53.1, time_varying: false, source: "coords", dims: [] },
  };
  const fromTemplate = (name: string) => ({ name, kind: "template" });
  const fromTable = (name: string) => ({ name, kind: "data_table" });

  it("reports a template's own keys against the template's name", () => {
    expect(collectInherited("power_lines", { flow_cap_max: 100 }, undefined)).toEqual({
      flow_cap_max: { value: "100", sources: [fromTemplate("power_lines")] },
    });
  });

  it("ignores template fields when the entry names no template", () => {
    // The caller passes whatever it has; without a name there is nothing
    // truthful to attribute the value to.
    expect(collectInherited(null, { flow_cap_max: 100 }, undefined)).toEqual({});
  });

  it("reports a data table against the table it came from", () => {
    expect(collectInherited(null, undefined, table)).toEqual({
      latitude: { value: "53.1", sources: [fromTable("coords")] },
    });
  });

  it("credits both sources when they agree", () => {
    expect(collectInherited("sites", { latitude: 53.1 }, table)).toEqual({
      latitude: {
        value: "53.1",
        sources: [fromTemplate("sites"), fromTable("coords")],
      },
    });
  });

  it("refuses to pick a winner when they disagree", () => {
    // Precedence between a template and a data table is Calliope's to answer,
    // not ours. A confident wrong number is worse than an honest "two sources".
    expect(collectInherited("sites", { latitude: 40.0 }, table)).toEqual({
      latitude: {
        value: null,
        sources: [fromTemplate("sites"), fromTable("coords")],
      },
    });
  });

  it("keeps a template and a table apart when they share a name", () => {
    // The case the kind exists for: a table named after the parameter it
    // supplies, which by name alone is indistinguishable from a template.
    const params = {
      flow_cap_max: {
        value: 5,
        time_varying: false,
        source: "flow_cap_max",
        dims: [],
      },
    };
    expect(
      collectInherited("flow_cap_max", { other: 1 }, params).flow_cap_max.sources,
    ).toEqual([fromTable("flow_cap_max")]);
  });

  it("renders a structured value as something a field can show", () => {
    const result = collectInherited("t", { cost: { data: 1, index: "monetary" } }, {});
    expect(result.cost.value).toBe('{"data":1,"index":"monetary"}');
  });

  it("shows nothing rather than 'null' for an unset template key", () => {
    expect(collectInherited("t", { flow_cap_max: null }, {}).flow_cap_max.value).toBe("");
  });

  it("carries a description through rather than a value", () => {
    const params = {
      flow_cap_max: {
        value: null,
        time_varying: false,
        source: "caps",
        dims: ["techs"],
      },
    };
    expect(collectInherited(null, undefined, params).flow_cap_max.value).toBe(
      "per techs",
    );
  });
});

describe("which keys an entry sets itself", () => {
  it("never counts template as an override", () => {
    // It is the thing doing the inheriting, so there is nothing to revert to.
    const node = rawToNode("a", { template: "sites" });
    expect(nodeSetsKey(node, "template")).toBe(false);
  });

  it("counts active only when it is false", () => {
    // Absent means active. A form showing the default has overridden nothing.
    expect(nodeSetsKey(rawToNode("a", {}), "active")).toBe(false);
    expect(nodeSetsKey(rawToNode("a", { active: false }), "active")).toBe(true);
    expect(techSetsKey(rawToTech("t", { active: false }), "active")).toBe(true);
    expect(linkSetsKey(rawToLink("l", { active: false }), "active")).toBe(true);
  });

  it("counts a coordinate of zero", () => {
    // `0` is a real latitude and `!entry.latitude` would call it unset.
    expect(nodeSetsKey(rawToNode("a", { latitude: 0 }), "latitude")).toBe(true);
    expect(nodeSetsKey(rawToNode("a", {}), "latitude")).toBe(false);
  });

  it("counts an arbitrary parameter", () => {
    const node = rawToNode("a", { available_area: 10 });
    expect(nodeSetsKey(node, "available_area")).toBe(true);
    expect(nodeSetsKey(node, "flow_cap_max")).toBe(false);
  });

  it("counts a link's endpoints", () => {
    const link = rawToLink("l", { link_from: "a", link_to: "b" });
    expect(linkSetsKey(link, "link_from")).toBe(true);
    expect(linkSetsKey(rawToLink("l", {}), "link_from")).toBe(false);
  });

  it("counts a tech's base_tech", () => {
    expect(techSetsKey(rawToTech("t", { base_tech: "supply" }), "base_tech")).toBe(true);
    expect(techSetsKey(rawToTech("t", {}), "base_tech")).toBe(false);
  });
});

describe("unmatchedInherited", () => {
  const from = [{ name: "t", kind: "template" as const }];
  const inherited = {
    flow_cap_max: { value: "100", sources: from },
    flow_out_eff: { value: "0.9", sources: from },
    base_tech: { value: "supply", sources: from },
  };

  it("leaves out what the form already has a field for", () => {
    expect(unmatchedInherited(inherited, ["base_tech"], [])).toEqual([
      "flow_cap_max",
      "flow_out_eff",
    ]);
  });

  it("leaves out what the entry already sets as a parameter", () => {
    expect(
      unmatchedInherited(inherited, ["base_tech"], [{ key: "flow_cap_max" }]),
    ).toEqual(["flow_out_eff"]);
  });

  it("is stable, so ghost rows do not reorder as the entry is edited", () => {
    expect(unmatchedInherited(inherited, [], [])).toEqual([
      "base_tech",
      "flow_cap_max",
      "flow_out_eff",
    ]);
  });
});
