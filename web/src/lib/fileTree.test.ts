import { describe, expect, it } from "vitest";

import { allPaths, buildFileTree, type FileEntry } from "./fileTree";

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

  it("keeps a directory that holds nothing", () => {
    // The whole reason directories are listed rather than inferred: a folder
    // the user has just created has no files in it yet, and inferring one from
    // the `/` in a file path cannot see it.
    const tree = buildFileTree([{ path: "scratch", type: "directory" }]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ key: "scratch", type: "directory", leaf: false });
    // Never `children: []` — Reka's `hasChildren` is a truthiness test, and an
    // empty array gives a leaf a chevron onto nothing.
    expect(tree[0].children).toEqual([]);
  });

  it("does not duplicate a directory that is both listed and implied", () => {
    const tree = buildFileTree([
      { path: "model_config", type: "directory" },
      entry("model_config/techs.yaml"),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
  });

  it("puts directories before files, whatever order they arrive in", () => {
    const tree = buildFileTree([
      entry("zzz.yaml"),
      entry("aaa.yaml"),
      { path: "model_config", type: "directory" },
    ]);
    expect(tree.map((node) => node.key)).toEqual(["model_config", "aaa.yaml", "zzz.yaml"]);
  });

  it("sorts numbered files the way a person reads them", () => {
    const tree = buildFileTree([entry("node_10.yaml"), entry("node_9.yaml")]);
    expect(tree.map((node) => node.key)).toEqual(["node_9.yaml", "node_10.yaml"]);
  });
});

/**
 * The set the new-file dialog checks a typed name against, so that "there is
 * already something called that" arrives while typing rather than as a 409.
 */
describe("allPaths", () => {
  it("collects files and directories at every depth", () => {
    const tree = buildFileTree([
      entry("model.yaml"),
      entry("a/b/deep.yaml"),
      { path: "empty", type: "directory" },
    ]);
    expect(allPaths(tree)).toEqual(
      new Set(["model.yaml", "a", "a/b", "a/b/deep.yaml", "empty"]),
    );
  });
});
