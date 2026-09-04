import { describe, expect, it } from "vitest";

import {
  compareTabId,
  entryTabId,
  fileTabId,
  parseTabId,
  runTabId,
  sectionTabId,
  tabId,
  type TabSpec,
} from "./tabId";

/**
 * Tab ids are a Map key, a DOM key and a URL query value at once, so the round
 * trip has to be exact and parsing has to be total.
 *
 * The scheme this replaced guessed where a file path ended by taking the last
 * colon in the string, so an entry named `cost:monetary` — which Calliope
 * permits — silently produced the wrong tab. That case is pinned below.
 */
const specs: TabSpec[] = [
  { kind: "file", path: "model.yaml" },
  { kind: "file", path: "model_config/techs.yaml" },
  { kind: "section", section: "techs", filePath: "model_config/techs.yaml" },
  {
    kind: "entry",
    section: "techs",
    filePath: "model_config/techs.yaml",
    entryName: "ccgt",
  },
  { kind: "run", runId: "0d1e2f34-5678-4abc-8def-000000000000", handle: null },
  { kind: "run", runId: null, handle: "2d3f9a1b4c5d6e7f" },
  { kind: "validation" },
  { kind: "math" },
  {
    kind: "compare",
    a: { kind: "run", runId: "0d1e2f34-5678-4abc-8def-000000000000" },
    b: { kind: "workspace", scenario: null },
  },
  {
    kind: "compare",
    a: { kind: "workspace", scenario: null },
    // A scenario may be a joined list of override names, commas and all.
    b: { kind: "workspace", scenario: "cold_fusion,high_cost" },
  },
];

describe("tabId", () => {
  it.each(specs)("round-trips %o", (spec) => {
    expect(parseTabId(tabId(spec))).toEqual(spec);
  });

  it("is stable, because the same tab must be one Map entry", () => {
    const spec: TabSpec = { kind: "file", path: "a/b.yaml" };
    expect(tabId(spec)).toBe(tabId({ ...spec }));
  });

  it.each([
    ["a slash", "model_config/techs.yaml"],
    ["a colon", "odd:name.yaml"],
    ["a space", "my model.yaml"],
    ["a hash", "a#b.yaml"],
    ["a question mark", "a?b.yaml"],
    ["an ampersand", "a&b.yaml"],
    ["unicode", "modèle/ünïcode.yaml"],
  ])("survives a path containing %s", (_label, path) => {
    expect(parseTabId(fileTabId(path))).toEqual({ kind: "file", path });
  });

  it("survives an entry name containing a colon", () => {
    // The previous scheme split on the *last* colon to find the entry name, so
    // this produced a file path of "…techs.yaml:cost" and an entry of "monetary".
    const id = entryTabId("techs", "model_config/techs.yaml", "cost:monetary");
    expect(parseTabId(id)).toEqual({
      kind: "entry",
      section: "techs",
      filePath: "model_config/techs.yaml",
      entryName: "cost:monetary",
    });
  });

  it("keeps a section tab distinct from the file it came from", () => {
    expect(sectionTabId("techs", "techs.yaml")).not.toBe(fileTabId("techs.yaml"));
  });

  it("parses the one id with no segments", () => {
    // `"validation".split(":")` leaves an empty tail, so the length check that
    // guards every other kind has to read 0 here rather than 1.
    expect(parseTabId("validation")).toEqual({ kind: "validation" });
    // And a tail it should not have is still rejected, like any other kind.
    expect(parseTabId("validation:extra")).toBeNull();
  });

  it("parses the math tab, which also carries no segment", () => {
    // Deliberately not `math:{source}`, though the tab filters by source: the
    // point of it is following a `Uses` reference from one component to another,
    // and a source in the id would make every hop a new tab.
    expect(parseTabId("math")).toEqual({ kind: "math" });
    expect(parseTabId("math:base")).toBeNull();
  });

  it("keeps a run and a bare results file distinct", () => {
    expect(runTabId("abc")).not.toBe(runTabId(null, "abc"));
    expect(parseTabId(runTabId(null, "abc"))).toEqual({
      kind: "run",
      runId: null,
      handle: "abc",
    });
  });

  it("is URL-safe, so a tab can be named in a query param", () => {
    for (const spec of specs) {
      const id = tabId(spec);
      // Round-tripping through URLSearchParams must not change it, or the
      // ?tab= value and the Map key would drift apart.
      const query = new URLSearchParams({ tab: id });
      expect(new URLSearchParams(query.toString()).get("tab")).toBe(id);
    }
  });

  it.each([
    ["an unknown prefix", "widget:thing"],
    ["no prefix at all", "model.yaml"],
    ["too few parts", "entry:techs"],
    ["too many parts", "file:a:b"],
    ["an empty string", ""],
    ["a legacy sentinel key", "\0s:techs:techs.yaml"],
  ])("returns null for %s rather than throwing", (_label, id) => {
    expect(parseTabId(id)).toBeNull();
  });
});

describe("compare tabs", () => {
  it("is unreadable as a whole when either side is", () => {
    // Half a comparison is not a comparison: better to open no tab than one
    // against something the app cannot name.
    expect(parseTabId("compare:run.abc:widget.x")).toBeNull();
    expect(parseTabId("compare:workspace")).toBeNull();
    expect(parseTabId("compare:workspace:workspace:workspace")).toBeNull();
  });

  it("keeps the two sides in order", () => {
    const run = { kind: "run", runId: "abc" } as const;
    const model = { kind: "workspace", scenario: null } as const;
    expect(compareTabId(run, model)).not.toBe(compareTabId(model, run));
  });
});
