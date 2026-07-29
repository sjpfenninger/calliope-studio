import { describe, expect, it } from "vitest";

import { buildModelTree, SECTIONS, STRUCTURED_SECTIONS } from "./modelTree";
import type { ComponentTree } from "../stores/componentTree";

/**
 * Turning the server's component tree into explorer rows.
 *
 * Extracted from the component that used to hold it precisely so it could be
 * tested: the ordering, the `config` special case and the fallback to a
 * section's own file are all invisible until a model with the right shape opens.
 */
describe("buildModelTree", () => {
  it("returns nothing for an unloaded tree", () => {
    expect(buildModelTree(null)).toEqual([]);
  });

  it("keeps sections in display order, not the order the server sent", () => {
    const tree = {
      scenarios: { file: "scenarios.yaml", entries: ["a"] },
      techs: { file: "techs.yaml", entries: ["ccgt"] },
      config: { file: "model.yaml" },
    } as ComponentTree;

    expect(buildModelTree(tree).map((row) => row.section)).toEqual([
      "config",
      "techs",
      "scenarios",
    ]);
  });

  it("omits sections the model does not have", () => {
    const tree = { techs: { file: "techs.yaml", entries: [] } } as ComponentTree;
    expect(buildModelTree(tree)).toHaveLength(1);
  });

  it("makes config a leaf, because it is one object rather than named entries", () => {
    const rows = buildModelTree({ config: { file: "model.yaml" } } as ComponentTree);
    expect(rows[0]).toMatchObject({ key: "config", label: "Config", file: "model.yaml" });
    expect(rows[0].children).toBeUndefined();
  });

  it("title-cases a section label", () => {
    const tree = { data_tables: { file: "m.yaml", entries: ["x"] } } as ComponentTree;
    expect(buildModelTree(tree)[0].label).toBe("Data tables");
  });

  it("gives an entry a key that cannot collide with its section", () => {
    const tree = { techs: { file: "t.yaml", entries: ["ccgt"] } } as ComponentTree;
    const [section] = buildModelTree(tree);
    expect(section.key).toBe("techs");
    expect(section.children?.[0].key).toBe("techs:ccgt");
  });

  it("carries an entry's own file, which may differ from its section's", () => {
    // Entries accumulate across the import graph, so a tech can be defined in a
    // different file from the one that first opened `techs:`.
    const tree = {
      techs: {
        file: "techs.yaml",
        entries: [{ name: "ccgt", file: "other/more_techs.yaml" }],
      },
    } as ComponentTree;
    expect(buildModelTree(tree)[0].children?.[0].file).toBe("other/more_techs.yaml");
  });

  it("keeps the section's own file when its entries span several", () => {
    // What the explorer's trailing badge on a section row renders, and the
    // reason it has to: the row opens `techs.yaml` and nothing else, even
    // though half the model's technologies are somewhere else entirely. The
    // server picks that file as the first in import order to define any entry
    // (`modeldef/imports.py`), so the group is emphatically not "all techs".
    const tree = {
      techs: {
        file: "techs.yaml",
        entries: [
          { name: "ccgt", file: "techs.yaml" },
          { name: "csp", file: "other/more_techs.yaml" },
        ],
      },
    } as ComponentTree;
    const [section] = buildModelTree(tree);
    expect(section.file).toBe("techs.yaml");
    expect(section.children?.map((child) => child.file)).toEqual([
      "techs.yaml",
      "other/more_techs.yaml",
    ]);
  });

  it("falls back to the section's file for a bare-string entry", () => {
    const tree = { techs: { file: "techs.yaml", entries: ["ccgt"] } } as ComponentTree;
    expect(buildModelTree(tree)[0].children?.[0].file).toBe("techs.yaml");
  });

  it("carries the template badge", () => {
    const tree = {
      techs: {
        file: "t.yaml",
        entries: [{ name: "ccgt", file: "t.yaml", template: "supply" }],
      },
    } as ComponentTree;
    expect(buildModelTree(tree)[0].children?.[0].template).toBe("supply");
  });

  it("carries an override's setting count and a scenario's overrides", () => {
    // Both are what make the explorer informative before anything is opened.
    const tree = {
      overrides: {
        file: "s.yaml",
        entries: [{ name: "spores", file: "s.yaml", setting_count: 9 }],
      },
      scenarios: {
        file: "s.yaml",
        entries: [{ name: "combo", file: "s.yaml", overrides: ["a", "b"] }],
      },
    } as ComponentTree;
    const rows = buildModelTree(tree);
    expect(rows.find((r) => r.section === "overrides")?.children?.[0].settingCount).toBe(9);
    expect(rows.find((r) => r.section === "scenarios")?.children?.[0].overrides).toEqual([
      "a",
      "b",
    ]);
  });

  it("leaves an empty section childless, so it renders as a leaf", () => {
    const tree = { techs: { file: "t.yaml", entries: [] } } as ComponentTree;
    expect(buildModelTree(tree)[0].children).toBeUndefined();
  });

  it("ignores a section name the display order does not know", () => {
    const tree = { widgets: { file: "w.yaml", entries: ["x"] } } as unknown as ComponentTree;
    expect(buildModelTree(tree)).toEqual([]);
  });
});

describe("STRUCTURED_SECTIONS", () => {
  it("covers every section with a form", () => {
    // `templates` is the one that is left, and deliberately: a template is an
    // arbitrary fragment inherited by anything, so the form for one would be
    // every other form at once.
    expect([...STRUCTURED_SECTIONS].sort()).toEqual([
      "config",
      "data_tables",
      "links",
      "nodes",
      "overrides",
      "scenarios",
      "techs",
    ]);
  });

  it("is a subset of the sections shown", () => {
    for (const section of STRUCTURED_SECTIONS) {
      expect(SECTIONS).toContain(section);
    }
  });
});
