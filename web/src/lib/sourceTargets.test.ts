import { describe, expect, it } from "vitest";

import { resolveSource } from "./sourceTargets";
import type { ComponentTree } from "@/api/versions";

/**
 * Where a provenance marker sends the user when they click it.
 *
 * The failure mode this guards is silent: a lookup that matches the wrong section
 * opens some other entry that happens to share a name, and the user reads a file
 * that has nothing to do with the value they were asking about. A model with a
 * data table named after a template is not hypothetical — the whole feature exists
 * because a table can be named `flow_cap_max`.
 */
const tree: ComponentTree = {
  templates: {
    file: "model.yaml",
    entries: [
      { name: "power_lines", file: "templates.yaml", line: 12 },
      { name: "shared", file: "templates.yaml", line: 20 },
    ],
  },
  data_tables: {
    file: "model.yaml",
    entries: [
      { name: "flow_cap_max", file: "tables.yaml", line: 4 },
      { name: "shared", file: "other.yaml", line: 8 },
    ],
  },
};

describe("resolveSource", () => {
  it("finds a template, with the line it is declared on", () => {
    expect(resolveSource(tree, { name: "power_lines", kind: "template" })).toEqual({
      section: "templates",
      file: "templates.yaml",
      name: "power_lines",
      line: 12,
    });
  });

  it("finds a data table", () => {
    expect(resolveSource(tree, { name: "flow_cap_max", kind: "data_table" })).toEqual({
      section: "data_tables",
      file: "tables.yaml",
      name: "flow_cap_max",
      line: 4,
    });
  });

  it("looks only in the section the kind names", () => {
    // `shared` exists in both, in different files. Matching by name alone would
    // send half the clicks to the wrong file.
    expect(resolveSource(tree, { name: "shared", kind: "template" })?.file).toBe(
      "templates.yaml",
    );
    expect(resolveSource(tree, { name: "shared", kind: "data_table" })?.file).toBe(
      "other.yaml",
    );
  });

  it("does not cross the sections", () => {
    // A data table named after a template must not open the template.
    expect(resolveSource(tree, { name: "flow_cap_max", kind: "template" })).toBeNull();
    expect(resolveSource(tree, { name: "power_lines", kind: "data_table" })).toBeNull();
  });

  it("gives up rather than guessing", () => {
    // The tree has not loaded, the name is not in a file yet, or an older server
    // sent no table name at all. None of these is an error; each just means there
    // is nowhere honest to send anyone.
    expect(resolveSource(null, { name: "power_lines", kind: "template" })).toBeNull();
    expect(resolveSource(tree, { name: "nope", kind: "template" })).toBeNull();
    expect(resolveSource(tree, { name: "data table", kind: "data_table" })).toBeNull();
    expect(resolveSource({}, { name: "power_lines", kind: "template" })).toBeNull();
  });

  it("skips a bare-string entry", () => {
    // The wire type still allows one, and it carries no file to open.
    const flat: ComponentTree = { templates: { entries: ["power_lines"] } };
    expect(resolveSource(flat, { name: "power_lines", kind: "template" })).toBeNull();
  });

  it("reports no line when the file could not be parsed for one", () => {
    const noLine: ComponentTree = {
      templates: { entries: [{ name: "t", file: "model.yaml" }] },
    };
    expect(resolveSource(noLine, { name: "t", kind: "template" })?.line).toBeUndefined();
  });
});
