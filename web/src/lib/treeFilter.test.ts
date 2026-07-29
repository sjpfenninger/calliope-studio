import { describe, expect, it } from "vitest";

import { buildModelTree, type ModelTreeNode } from "./modelTree";
import { buildFileTree, type FileTreeNode } from "./fileTree";
import { ancestorKeys, branchKeys, filterTree } from "./treeFilter";

/**
 * The filter both explorer trees run on.
 *
 * Worth pinning in detail because every failure here is silent: a pruned tree
 * that drops a branch it should have kept looks exactly like a model that does
 * not contain what the user typed, and an expansion set that misses an ancestor
 * looks like a filter that found nothing at all.
 */

const model = buildModelTree({
  config: { file: "model.yaml" },
  techs: {
    file: "techs.yaml",
    entries: [
      { name: "ccgt", file: "techs.yaml" },
      { name: "csp", file: "techs.yaml" },
      { name: "battery", file: "techs.yaml" },
    ],
  },
  nodes: { file: "nodes.yaml", entries: [{ name: "region1", file: "nodes.yaml" }] },
});

const files = buildFileTree([
  { path: "model.yaml", type: "yaml", size: 1 },
  { path: "model/techs.yaml", type: "yaml", size: 1 },
  { path: "model/nodes.yaml", type: "yaml", size: 1 },
  { path: "data/timeseries/demand.csv", type: "csv", size: 1 },
  { path: "data/timeseries/supply.csv", type: "csv", size: 1 },
]);

const byLabel = (node: ModelTreeNode | FileTreeNode) => node.label;
const byKey = (node: FileTreeNode) => node.key;

/** Every label in the pruned tree, depth first, so a shape can be asserted flat. */
function labels<T extends { label: string; children?: T[] }>(items: T[]): string[] {
  return items.flatMap((item) => [item.label, ...labels(item.children ?? [])]);
}

describe("filterTree", () => {
  it("returns the input array itself when there is nothing to filter by", () => {
    // Identity, not equality: an explorer is unfiltered nearly all the time, and
    // a fresh array every render would cost Reka its row reuse.
    for (const query of ["", "   "]) {
      const result = filterTree(model, query, byLabel);
      expect(result.items).toBe(model);
      expect(result.expanded).toEqual([]);
    }
  });

  it("keeps a matching leaf and every branch above it", () => {
    const result = filterTree(model, "ccgt", byLabel);
    expect(labels(result.items)).toEqual(["Techs", "ccgt"]);
    // The section has to be open or the one match it was kept for is invisible.
    expect(result.expanded).toEqual(["techs"]);
  });

  it("matches without regard to case", () => {
    expect(labels(filterTree(model, "CCGT", byLabel).items)).toEqual(["Techs", "ccgt"]);
  });

  it("keeps a matching branch whole, and opens it", () => {
    // Typing a section name means "show me that section", so its entries come
    // with it rather than the row arriving empty.
    const result = filterTree(model, "techs", byLabel);
    expect(labels(result.items)).toEqual(["Techs", "ccgt", "csp", "battery"]);
    expect(result.expanded).toEqual(["techs"]);
  });

  it("leaves a matching branch as the object it was given", () => {
    const techs = model.find((node) => node.key === "techs")!;
    expect(filterTree(model, "techs", byLabel).items[0]).toBe(techs);
  });

  it("does not open the branches inside a match", () => {
    // One hit on a folder would otherwise open every directory beneath it.
    const result = filterTree(files, "data", byKey);
    expect(result.expanded).toEqual(["data"]);
    expect(labels(result.items)).toEqual([
      "data",
      "timeseries",
      "demand.csv",
      "supply.csv",
    ]);
  });

  it("gives a rebuilt branch a pruned children array, never an empty one", () => {
    // Reka's `hasChildren` is a truthiness test, so `children: []` draws a
    // chevron on a row that opens onto nothing.
    const result = filterTree(model, "csp", byLabel);
    expect(result.items[0].children).toEqual([expect.objectContaining({ label: "csp" })]);
    expect(result.items[0].children![0].children).toBeUndefined();
  });

  it("keeps a matching leaf with no children as a leaf", () => {
    // `config` is a root with no entries; the model tree gives it no `children`
    // key at all, and the filter must not invent one.
    const result = filterTree(model, "config", byLabel);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].children).toBeUndefined();
  });

  it("drops branches that neither match nor contain a match", () => {
    expect(labels(filterTree(model, "region", byLabel).items)).toEqual([
      "Nodes",
      "region1",
    ]);
  });

  it("returns nothing when nothing matches", () => {
    const result = filterTree(model, "nonexistent", byLabel);
    expect(result.items).toEqual([]);
    expect(result.expanded).toEqual([]);
  });

  it("opens every ancestor of a deep match", () => {
    const result = filterTree(files, "demand", byKey);
    expect(labels(result.items)).toEqual(["data", "timeseries", "demand.csv"]);
    // Sorted, because the expansion is a set of keys: Reka reads it with
    // `includes`, so the order it comes out of the recursion in means nothing.
    expect([...result.expanded].sort()).toEqual(["data", "data/timeseries"]);
  });

  it("narrows a file tree by path, which a label alone could not", () => {
    // Two files called `techs.yaml` in different directories are otherwise
    // indistinguishable, and the path is the only thing that tells them apart.
    const result = filterTree(files, "model/", byKey);
    // Alphabetical within the directory: `buildFileTree` sorts, so this is not
    // the order the entries were listed in above.
    expect(labels(result.items)).toEqual(["model", "nodes.yaml", "techs.yaml"]);
  });
});

describe("branchKeys", () => {
  it("gives every openable node, at every depth", () => {
    // `data` before `model` for the same reason: the file tree is sorted, not
    // in listing order. Directories come first and then sort by name.
    expect(branchKeys(files)).toEqual(["data", "data/timeseries", "model"]);
  });

  it("leaves out the leaves, including a childless root", () => {
    // `config` is a model-tree root with no entries; "expand all" must not
    // claim it as something that could be opened, or the button would say
    // "collapse all" about a tree that is already as open as it goes.
    expect(branchKeys(model)).toEqual(["techs", "nodes"]);
  });

  it("answers about the filtered tree it is given", () => {
    const result = filterTree(files, "demand", byKey);
    expect(branchKeys(result.items)).toEqual(["data", "data/timeseries"]);
  });

  it("gives nothing for a tree with no branches at all", () => {
    expect(branchKeys(filterTree(files, "model.yaml", byKey).items)).toEqual([]);
  });
});

describe("ancestorKeys", () => {
  it("gives the path down to a node, without the node itself", () => {
    expect(ancestorKeys(files, "data/timeseries/demand.csv")).toEqual([
      "data",
      "data/timeseries",
    ]);
  });

  it("gives nothing for a root", () => {
    expect(ancestorKeys(files, "model.yaml")).toEqual([]);
  });

  it("gives nothing for a key that is not in the tree", () => {
    expect(ancestorKeys(files, "absent.yaml")).toEqual([]);
  });
});
