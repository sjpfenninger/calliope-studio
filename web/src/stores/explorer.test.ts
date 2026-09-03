import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { useExplorerStore } from "./explorer";

/**
 * The two expansion sets, and which one a toggle lands in.
 *
 * This is the whole of what makes a search reversible: if Reka's expand and
 * collapse ever reached `browseExpanded` during a query, clearing the field
 * would hand the user back a tree opened by their search rather than the one
 * they had built, and there would be nothing left anywhere to restore it from.
 */
describe("useExplorerStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("keeps the user's own expansion untouched across a search", () => {
    const explorer = useExplorerStore();
    explorer.setExpanded("model", ["techs"]);

    explorer.setQuery("model", "ccgt");
    explorer.setExpanded("model", ["techs", "nodes", "links"]);
    explorer.setQuery("model", "");

    expect(explorer.browseExpanded.model).toEqual(["techs"]);
  });

  it("forgets the search's own expansion as soon as the query changes", () => {
    // Otherwise the branches one query opened stay open under the next, which
    // reads as the filter opening things at random.
    const explorer = useExplorerStore();
    explorer.setQuery("model", "cc");
    explorer.setExpanded("model", ["techs"]);

    explorer.setQuery("model", "ccg");

    expect(explorer.searchExpanded.model).toBeNull();
  });

  it("keeps the two trees apart", () => {
    const explorer = useExplorerStore();
    explorer.setQuery("model", "ccgt");
    explorer.setExpanded("files", ["model"]);

    expect(explorer.query.files).toBe("");
    expect(explorer.browseExpanded.files).toEqual(["model"]);
    expect(explorer.browseExpanded.model).toEqual([]);
  });

  it("keeps a selection per tree, so the two cannot overwrite each other", () => {
    const explorer = useExplorerStore();
    explorer.setSelected("files", "data_tables/costs.csv");
    explorer.setSelected("model", "techs:ccgt");

    expect(explorer.selected.files).toBe("data_tables/costs.csv");
    expect(explorer.selected.model).toBe("techs:ccgt");
  });

  it("holds the selection across a section switch", () => {
    /**
     * The whole reason it is here. `ModelSection` and `FilesSection` are
     * lazily-mounted route components with no `<keep-alive>`, so the local
     * `ref` this replaces died every time the user went to Runs and back — and
     * where "New file" lands is read off it, so a folder selected before the
     * detour was silently the model root afterwards.
     */
    const explorer = useExplorerStore();
    explorer.setSelected("files", "model_config");

    // What a remount does: a fresh component, the same store.
    expect(useExplorerStore().selected.files).toBe("model_config");
  });

  it("clears a selection when it is set to nothing", () => {
    const explorer = useExplorerStore();
    explorer.setSelected("files", "model_config");
    explorer.setSelected("files", null);

    expect(explorer.selected.files).toBeNull();
  });

  it("forgets everything on a reset, because it all names one model", () => {
    // A key is a path in the model just left, and a filter still applied would
    // hide most of the new one with nothing on screen to blame it on.
    const explorer = useExplorerStore();
    explorer.setSelected("files", "model_config/techs.yaml");
    explorer.setSelected("model", "techs:ccgt");
    explorer.setExpanded("files", ["model_config"]);
    explorer.setQuery("model", "ccgt");
    explorer.setExpanded("model", ["techs"]);

    explorer.reset();

    expect(explorer.selected).toEqual({ model: null, files: null });
    expect(explorer.query).toEqual({ model: "", files: "" });
    expect(explorer.browseExpanded).toEqual({ model: [], files: [] });
    expect(explorer.searchExpanded).toEqual({ model: null, files: null });
  });

  it("merges revealed branches without repeating one", () => {
    const explorer = useExplorerStore();
    explorer.setExpanded("files", ["data"]);
    explorer.reveal("files", ["data", "data/timeseries"]);

    expect(explorer.browseExpanded.files).toEqual(["data", "data/timeseries"]);
  });
});
