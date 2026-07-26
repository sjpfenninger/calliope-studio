import { describe, expect, it } from "vitest";

import { buildFileTree, type FileEntry } from "./fileTree";

function entry(path: string, type: FileEntry["type"] = "yaml", size = 10): FileEntry {
  return { path, type, size };
}

/**
 * Turning a flat listing into a tree, for both the workspace's files and a run's
 * frozen copy of them. The two endpoints return the same shape on purpose, so
 * this is the one place the nesting is worked out.
 */
describe("buildFileTree", () => {
  it("keeps top-level files at the top level", () => {
    expect(buildFileTree([entry("model.yaml")])).toEqual([
      { key: "model.yaml", label: "model.yaml", type: "yaml", leaf: true, size: 10 },
    ]);
  });

  it("creates a directory node for a nested file", () => {
    const tree = buildFileTree([entry("model_config/techs.yaml")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      key: "model_config",
      label: "model_config",
      type: "directory",
      leaf: false,
    });
    expect(tree[0].children?.[0]).toMatchObject({ key: "model_config/techs.yaml" });
  });

  it("creates each directory once, however many files it holds", () => {
    const tree = buildFileTree([
      entry("model_config/techs.yaml"),
      entry("model_config/nodes.yaml"),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(2);
  });

  it("nests directories several deep", () => {
    const tree = buildFileTree([entry("a/b/c/deep.yaml")]);
    expect(tree[0].children?.[0].children?.[0].children?.[0]).toMatchObject({
      key: "a/b/c/deep.yaml",
      label: "deep.yaml",
    });
  });

  it("labels a node with its own name, not its path", () => {
    const tree = buildFileTree([entry("data_tables/demand.csv", "csv")]);
    expect(tree[0].children?.[0].label).toBe("demand.csv");
  });

  it("carries the size on files and not on directories", () => {
    // The frozen tree shows sizes; a directory does not have one to show.
    const tree = buildFileTree([entry("data_tables/demand.csv", "csv", 4096)]);
    expect(tree[0].size).toBeUndefined();
    expect(tree[0].children?.[0].size).toBe(4096);
  });

  it("handles an empty listing", () => {
    // A run with no snapshot answers with an empty list rather than a 404.
    expect(buildFileTree([])).toEqual([]);
  });
});
