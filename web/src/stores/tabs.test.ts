import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/versions", () => ({
  putFile: vi.fn(),
  putCsv: vi.fn(),
}));

import { putCsv, putFile } from "../api/versions";

import {
  entryTabId,
  fileTabId,
  mathTabId,
  runTabId,
  sectionTabId,
  validationTabId,
} from "../lib/tabId";
import { useTabsStore } from "./tabs";

/**
 * The tab model, which is the de facto navigation state for the whole app: a run
 * opens in the same bar as a YAML file, so "what am I looking at" has one answer.
 */
describe("useTabsStore", () => {
  beforeEach(() => setActivePinia(createPinia()));

  describe("opening", () => {
    it("opens a file and makes it active", () => {
      const tabs = useTabsStore();
      const id = tabs.openFile("model.yaml");
      expect(tabs.activeId).toBe(id);
      expect(tabs.activeFilePath).toBe("model.yaml");
    });

    it("is idempotent: opening the same thing twice re-activates it", () => {
      const tabs = useTabsStore();
      tabs.openFile("a.yaml");
      tabs.openFile("b.yaml");
      tabs.openFile("a.yaml");

      expect(tabs.openTabs.size).toBe(2);
      expect(tabs.activeId).toBe(fileTabId("a.yaml"));
    });

    it("infers the file type, so the right editor mounts", () => {
      const tabs = useTabsStore();
      tabs.openFile("data_tables/costs.csv");
      expect(tabs.get(fileTabId("data_tables/costs.csv"))).toMatchObject({
        kind: "file",
        fileType: "csv",
      });
    });

    it("titles a tab with its leaf, not its whole path", () => {
      const tabs = useTabsStore();
      tabs.openFile("model_config/techs.yaml");
      expect(tabs.activeTab?.title).toBe("techs.yaml");
    });

    it("keeps a section tab and its file apart", () => {
      const tabs = useTabsStore();
      tabs.openFile("techs.yaml");
      tabs.openSection("techs", "techs.yaml");
      expect(tabs.openTabs.size).toBe(2);
    });

    it("opens an entry tab carrying its own fields", () => {
      const tabs = useTabsStore();
      tabs.openEntry("techs", "techs.yaml", "ccgt");
      expect(tabs.get(entryTabId("techs", "techs.yaml", "ccgt"))).toMatchObject({
        kind: "entry",
        section: "techs",
        filePath: "techs.yaml",
        entryName: "ccgt",
        editorMode: "structured",
      });
    });
  });

  describe("activeFilePath", () => {
    it.each([
      ["a section tab", (t: ReturnType<typeof useTabsStore>) => t.openSection("techs", "f.yaml")],
      ["an entry tab", (t: ReturnType<typeof useTabsStore>) => t.openEntry("techs", "f.yaml", "ccgt")],
      ["a run tab", (t: ReturnType<typeof useTabsStore>) => t.openRun({ id: "r1" })],
    ])("is null for %s", (_label, open) => {
      const tabs = useTabsStore();
      open(tabs);
      // Consumers use this to decide whether they are looking at a real file on
      // disk; a virtual tab must not masquerade as one.
      expect(tabs.activeFilePath).toBeNull();
    });
  });

  describe("run tabs", () => {
    it("opens on the log when there are no results yet", () => {
      const tabs = useTabsStore();
      tabs.openRun({ id: "r1" });
      expect(tabs.get(runTabId("r1"))).toMatchObject({ subView: "log", handle: null });
    });

    it("opens on the results when a handle is already known", () => {
      const tabs = useTabsStore();
      tabs.openRun({ id: "r1", handle: "abc" });
      expect(tabs.get(runTabId("r1"))).toMatchObject({ subView: "results" });
    });

    it("picks up a handle a finished run has since acquired", () => {
      // The run was opened the instant it started, so its tab existed before
      // results did. Without this it would show the log for ever.
      const tabs = useTabsStore();
      tabs.openRun({ id: "r1" });
      tabs.openRun({ id: "r1", handle: "abc" });

      expect(tabs.openTabs.size).toBe(1);
      expect(tabs.get(runTabId("r1"))).toMatchObject({ handle: "abc" });
    });

    it("keeps a bare results file distinct from a run", () => {
      const tabs = useTabsStore();
      tabs.openRun({ id: "r1" });
      tabs.openRun({ id: null, handle: "abc" });
      expect(tabs.openTabs.size).toBe(2);
    });

    it("latches each sub-view the first time it is shown", () => {
      const tabs = useTabsStore();
      const id = tabs.openRun({ id: "r1" });
      expect(tabs.get(id)).toMatchObject({ seenViews: ["log"] });

      tabs.setSubView(id, "config");
      tabs.setSubView(id, "log");

      // The results pane builds a map and three charts; creating either inside a
      // hidden container hands MapLibre a zero-size element to fit bounds to.
      // Latching is what lets a pane be created only when it is visible, and
      // kept alive afterwards.
      expect(tabs.get(id)).toMatchObject({ seenViews: ["log", "config"] });
    });

    it("latches the results view when a handle arrives", () => {
      const tabs = useTabsStore();
      const id = tabs.openRun({ id: "r1" });
      tabs.updateRun("r1", { handle: "abc" });

      expect(tabs.get(id)).toMatchObject({
        subView: "results",
        seenViews: ["log", "results"],
      });
    });

    it("leaves the sub-view alone when the user has moved off the log", () => {
      const tabs = useTabsStore();
      const id = tabs.openRun({ id: "r1" });
      tabs.setSubView(id, "config");

      tabs.updateRun("r1", { handle: "abc" });

      // Yanking someone out of the frozen config they are reading, because a
      // solve happened to finish, is the kind of helpfulness nobody wants.
      expect(tabs.get(id)).toMatchObject({ subView: "config", handle: "abc" });
    });

    it("is never dirty", () => {
      const tabs = useTabsStore();
      tabs.openRun({ id: "r1" });
      tabs.markDirty(runTabId("r1"));
      // A run is frozen. The literal `isDirty: false` on RunTab also makes this
      // a compile error, but the guard has to hold at runtime too.
      expect(tabs.hasDirtyTabs).toBe(false);
    });
  });

  describe("dirty state", () => {
    it("tracks and clears", () => {
      const tabs = useTabsStore();
      const id = tabs.openFile("model.yaml");

      tabs.markDirty(id);
      expect(tabs.hasDirtyTabs).toBe(true);

      tabs.markClean(id);
      expect(tabs.hasDirtyTabs).toBe(false);
    });
  });

  /**
   * The one tab a plain click may reuse. Every rule here exists because the
   * alternative loses something the user did: evicting a dirty preview throws
   * away an unsaved buffer, and demoting a tab that was deliberately opened
   * makes the next click delete it.
   */
  describe("the preview slot", () => {
    it("reuses one tab for successive plain clicks", () => {
      const tabs = useTabsStore();
      tabs.openFile("a.yaml", { preview: true });
      tabs.openFile("b.yaml", { preview: true });
      tabs.openFile("c.yaml", { preview: true });

      expect([...tabs.openTabs.keys()]).toEqual([fileTabId("c.yaml")]);
      expect(tabs.previewId).toBe(fileTabId("c.yaml"));
    });

    it("keeps every tab a Cmd-click opened", () => {
      const tabs = useTabsStore();
      tabs.openFile("a.yaml");
      tabs.openFile("b.yaml");
      tabs.openFile("c.yaml", { preview: true });

      expect(tabs.openTabs.size).toBe(3);
      expect(tabs.previewId).toBe(fileTabId("c.yaml"));
    });

    it("leaves a permanent tab permanent when it is clicked again", () => {
      // Otherwise a tab you had pinned would silently become the one the next
      // click throws away. The preview tab is untouched by the visit, exactly as
      // it is when an already-open file is clicked in an editor.
      const tabs = useTabsStore();
      const permanent = tabs.openFile("a.yaml");
      tabs.openFile("b.yaml", { preview: true });
      tabs.openFile("a.yaml", { preview: true });

      expect(tabs.previewId).toBe(fileTabId("b.yaml"));
      expect(tabs.openTabs.size).toBe(2);
      expect(tabs.activeId).toBe(permanent);
    });

    it("promotes the preview when it is re-opened permanently", () => {
      // A double-click: the first click previews, the second re-opens it.
      const tabs = useTabsStore();
      const id = tabs.openFile("a.yaml", { preview: true });
      tabs.openFile("a.yaml");

      expect(tabs.previewId).toBeNull();
      expect(tabs.openTabs.size).toBe(1);
      expect(tabs.get(id)).toBeDefined();
    });

    it("never evicts a preview that has been edited", () => {
      const tabs = useTabsStore();
      const edited = tabs.openFile("a.yaml", { preview: true });
      tabs.markDirty(edited);
      expect(tabs.previewId).toBeNull();

      tabs.openFile("b.yaml", { preview: true });
      expect(tabs.get(edited)).toBeDefined();
      expect(tabs.openTabs.size).toBe(2);
    });

    it("empties the slot when the preview is closed", () => {
      const tabs = useTabsStore();
      const id = tabs.openFile("a.yaml", { preview: true });
      tabs.closeTab(id);
      expect(tabs.previewId).toBeNull();
    });

    it("previews sections, entries and runs alike", () => {
      const tabs = useTabsStore();
      tabs.openSection("techs", "techs.yaml", { preview: true });
      tabs.openEntry("techs", "techs.yaml", "ccgt", { preview: true });
      tabs.openRun({ id: "r1" }, { preview: true });

      expect([...tabs.openTabs.keys()]).toEqual([runTabId("r1")]);
      expect(tabs.previewId).toBe(runTabId("r1"));
    });

    it("restores and deep-links into permanent tabs", () => {
      // A restored session must not hand the user a tab that the first click
      // deletes.
      const tabs = useTabsStore();
      tabs.openFromId(fileTabId("a.yaml"));
      expect(tabs.previewId).toBeNull();
    });

    it("never previews the validation tab", () => {
      // It lists the problems the user is about to go and fix, and fixing one
      // means clicking a file in the tree — which empties the preview slot. A
      // previewed validation tab would close itself on the first click it
      // caused.
      const tabs = useTabsStore();
      tabs.openValidation();
      expect(tabs.previewId).toBeNull();

      tabs.openFile("a.yaml", { preview: true });
      expect(tabs.has(validationTabId())).toBe(true);
    });

    it("never previews the math tab", () => {
      // Same reason as validation, and one more: rendering the math costs
      // seconds of a subprocess, and a tab that closes itself on the next click
      // in the tree would throw that away and start again on the way back.
      const tabs = useTabsStore();
      tabs.openMath();
      expect(tabs.previewId).toBeNull();

      tabs.openFile("a.yaml", { preview: true });
      expect(tabs.has(mathTabId())).toBe(true);
    });

    it("reopens the math tab from its id", () => {
      // What makes `?tab=math` and the persisted tab set work.
      const tabs = useTabsStore();
      tabs.openFromId(mathTabId());
      expect(tabs.activeTab?.kind).toBe("math");
      expect(tabs.activeTab?.isDirty).toBe(false);
    });
  });

  describe("closing", () => {
    it("activates the right-hand neighbour", () => {
      // The previous store jumped to whatever was last in the map, so closing a
      // middle tab threw you to the far end of the bar.
      const tabs = useTabsStore();
      tabs.openFile("a.yaml");
      const middle = tabs.openFile("b.yaml");
      tabs.openFile("c.yaml");
      tabs.activate(middle);

      tabs.closeTab(middle);
      expect(tabs.activeId).toBe(fileTabId("c.yaml"));
    });

    it("falls back to the left when closing the last tab", () => {
      const tabs = useTabsStore();
      tabs.openFile("a.yaml");
      const last = tabs.openFile("b.yaml");

      tabs.closeTab(last);
      expect(tabs.activeId).toBe(fileTabId("a.yaml"));
    });

    it("leaves nothing active when the last tab goes", () => {
      const tabs = useTabsStore();
      tabs.closeTab(tabs.openFile("a.yaml"));
      expect(tabs.activeId).toBeNull();
    });

    it("does not change the active tab when closing another one", () => {
      const tabs = useTabsStore();
      const first = tabs.openFile("a.yaml");
      const second = tabs.openFile("b.yaml");
      tabs.activate(second);

      tabs.closeTab(first);
      expect(tabs.activeId).toBe(second);
    });
  });

  /**
   * The bar's order is the Map's insertion order, so a move rebuilds the Map.
   * That is cheap and has one true source, but it is also the one operation here
   * that touches every entry at once — a mistake in it does not lose a position,
   * it loses tabs.
   */
  describe("reordering", () => {
    const three = () => {
      const tabs = useTabsStore();
      tabs.openFile("a.yaml");
      tabs.openFile("b.yaml");
      tabs.openFile("c.yaml");
      return tabs;
    };
    const order = (tabs: ReturnType<typeof useTabsStore>) =>
      tabs.ordered.map((tab) => tab.title);

    it("moves a tab to the right", () => {
      const tabs = three();
      tabs.moveTab(fileTabId("a.yaml"), 2);
      expect(order(tabs)).toEqual(["b.yaml", "c.yaml", "a.yaml"]);
    });

    it("moves a tab to the left", () => {
      const tabs = three();
      tabs.moveTab(fileTabId("c.yaml"), 0);
      expect(order(tabs)).toEqual(["c.yaml", "a.yaml", "b.yaml"]);
    });

    it("clamps an index past either end", () => {
      const tabs = three();
      tabs.moveTab(fileTabId("b.yaml"), 99);
      tabs.moveTab(fileTabId("a.yaml"), -4);
      expect(order(tabs)).toEqual(["a.yaml", "c.yaml", "b.yaml"]);
    });

    it("does nothing for an unknown id or a move to where the tab already is", () => {
      const tabs = three();
      tabs.moveTab(fileTabId("nowhere.yaml"), 0);
      tabs.moveTab(fileTabId("b.yaml"), 1);
      expect(order(tabs)).toEqual(["a.yaml", "b.yaml", "c.yaml"]);
    });

    it("carries each tab's own state across, rather than rebuilding it", () => {
      // The entries are the same objects on the other side of the move: a dirty
      // buffer or a mounted run pane must not be disturbed by a drag.
      const tabs = three();
      const id = fileTabId("a.yaml");
      tabs.markDirty(id);
      const entry = tabs.get(id);

      tabs.moveTab(id, 2);
      expect(tabs.get(id)).toBe(entry);
      expect(tabs.get(id)?.isDirty).toBe(true);
      expect(tabs.activeId).toBe(fileTabId("c.yaml"));
    });

    it("is what the next session reopens", () => {
      localStorage.clear();
      const first = three();
      first.setVersion("v1");
      first.moveTab(fileTabId("c.yaml"), 0);
      first.persist();

      setActivePinia(createPinia());
      const restored = useTabsStore();
      restored.restore("v1");

      expect(restored.ordered.map((tab) => tab.title)).toEqual([
        "c.yaml",
        "a.yaml",
        "b.yaml",
      ]);
    });
  });

  describe("mounting", () => {
    it("latches on first activation, so a pane is built once", () => {
      const tabs = useTabsStore();
      const id = tabs.openFile("a.yaml");
      expect(tabs.get(id)?.mounted).toBe(true);

      tabs.openFile("b.yaml");
      // Still mounted while in the background: switching back must not rebuild
      // an ECharts instance or a map.
      expect(tabs.get(id)?.mounted).toBe(true);
    });

    it("drops the least recently fronted run pane beyond the cap", () => {
      const tabs = useTabsStore();
      const ids = ["r1", "r2", "r3", "r4", "r5"].map((id) => tabs.openRun({ id }));

      // Five live run panes is five maps and fifteen charts; the oldest goes.
      expect(tabs.get(ids[0])?.mounted).toBe(false);
      expect(tabs.get(ids[4])?.mounted).toBe(true);
    });

    it("never drops the pane that is in front", () => {
      const tabs = useTabsStore();
      const ids = ["r1", "r2", "r3", "r4", "r5"].map((id) => tabs.openRun({ id }));
      tabs.activate(ids[0]);
      expect(tabs.get(ids[0])?.mounted).toBe(true);
    });
  });

  describe("reopening from an id", () => {
    it.each([
      ["a file", () => fileTabId("model.yaml")],
      ["a section", () => sectionTabId("techs", "techs.yaml")],
      ["an entry", () => entryTabId("techs", "techs.yaml", "ccgt")],
      ["a run", () => runTabId("r1")],
    ])("restores %s", (_label, makeId) => {
      const tabs = useTabsStore();
      const id = makeId();
      expect(tabs.openFromId(id)).toBe(id);
      expect(tabs.has(id)).toBe(true);
    });

    it("ignores an id it cannot parse", () => {
      // These travel in URLs, and a bookmark outlives the scheme that wrote it.
      const tabs = useTabsStore();
      expect(tabs.openFromId("\0s:techs:techs.yaml")).toBeNull();
      expect(tabs.openTabs.size).toBe(0);
    });
  });

  describe("persistence", () => {
    beforeEach(() => localStorage.clear());

    it("reopens the tabs a model had last time", () => {
      const first = useTabsStore();
      first.setVersion("v1");
      first.openFile("model.yaml");
      first.openSection("techs", "techs.yaml");
      first.persist();

      setActivePinia(createPinia());
      const restored = useTabsStore();
      restored.setVersion("v1");
      restored.restore("v1");

      expect([...restored.openTabs.keys()]).toEqual([
        fileTabId("model.yaml"),
        sectionTabId("techs", "techs.yaml"),
      ]);
    });

    it("hands back which tab was in front rather than activating it", () => {
      // A `?tab=` in the URL has to win over what the last session left open,
      // so the caller decides.
      const first = useTabsStore();
      first.setVersion("v1");
      first.openFile("a.yaml");
      first.openFile("b.yaml");
      first.persist();

      setActivePinia(createPinia());
      const restored = useTabsStore();
      expect(restored.restore("v1")).toBe(fileTabId("b.yaml"));
      expect(restored.activeId).toBeNull();
    });

    it("mounts nothing while restoring", () => {
      // Restoring six tabs would otherwise build six panes, five of them inside
      // a hidden container — which hands MapLibre a zero-size element.
      const first = useTabsStore();
      first.setVersion("v1");
      first.openRun({ id: "r1" });
      first.openRun({ id: "r2" });
      first.persist();

      setActivePinia(createPinia());
      const restored = useTabsStore();
      restored.restore("v1");

      expect(restored.ordered.every((tab) => !tab.mounted)).toBe(true);
    });

    it("keeps each model's tabs to itself", () => {
      const store = useTabsStore();
      store.setVersion("v1");
      store.openFile("a.yaml");
      store.persist();

      setActivePinia(createPinia());
      const other = useTabsStore();
      expect(other.restore("v2")).toBeNull();
      expect(other.openTabs.size).toBe(0);
    });

    it("ignores a stored entry it cannot read", () => {
      localStorage.setItem("calliope-studio.tabs.v1", "not json");
      const store = useTabsStore();
      expect(store.restore("v1")).toBeNull();
    });

    it("skips a tab id that no longer parses", () => {
      // These outlive the scheme that wrote them.
      localStorage.setItem(
        "calliope-studio.tabs.v1",
        JSON.stringify({ tabs: ["\0s:techs:techs.yaml", fileTabId("a.yaml")] }),
      );
      const store = useTabsStore();
      store.restore("v1");
      expect([...store.openTabs.keys()]).toEqual([fileTabId("a.yaml")]);
    });

    it("does not resurrect a tab that was closed", () => {
      const store = useTabsStore();
      store.setVersion("v1");
      const id = store.openFile("a.yaml");
      store.persist();
      store.closeTab(id);
      store.persist();

      setActivePinia(createPinia());
      const restored = useTabsStore();
      restored.restore("v1");
      expect(restored.openTabs.size).toBe(0);
    });
  });

  describe("jumping", () => {
    it("opens the file and records where to reveal", () => {
      const tabs = useTabsStore();
      tabs.jumpTo("model.yaml", 12, 3);

      expect(tabs.activeFilePath).toBe("model.yaml");
      expect(tabs.jumpTarget).toEqual({ path: "model.yaml", line: 12, column: 3 });
    });
  });

  describe("back and forward", () => {
    it("has nowhere to go before anything is opened", () => {
      const tabs = useTabsStore();
      expect(tabs.canGoBack).toBe(false);
      expect(tabs.canGoForward).toBe(false);
    });

    it("returns to the tab a jump left behind, and forward again", () => {
      const tabs = useTabsStore();
      tabs.openEntry("techs", "techs.yaml", "ccgt");
      tabs.jumpTo("templates.yaml", 34, 1);

      tabs.back();
      expect(tabs.activeId).toBe(entryTabId("techs", "techs.yaml", "ccgt"));
      expect(tabs.canGoForward).toBe(true);

      tabs.forward();
      expect(tabs.activeId).toBe(fileTabId("templates.yaml"));
    });

    it("replays the line, since Monaco keeps no position of its own", () => {
      const tabs = useTabsStore();
      tabs.openEntry("techs", "techs.yaml", "ccgt");
      tabs.jumpTo("templates.yaml", 34, 1);
      // The consumer nulls it, so forward has to set it again or the tab comes
      // back at line 1 — which reads as the button half-working.
      tabs.jumpTarget = null;

      tabs.back();
      tabs.forward();
      expect(tabs.jumpTarget).toEqual({ path: "templates.yaml", line: 34, column: 1 });
    });

    it("reopens a tab the preview slot evicted", () => {
      const tabs = useTabsStore();
      // Exactly what a plain click in the model tree followed by a plain click
      // on a provenance marker does: the second one closes the first one's tab.
      const entry = tabs.openEntry("techs", "techs.yaml", "ccgt", { preview: true });
      tabs.jumpTo("templates.yaml", 34, 1, { preview: true });
      expect(tabs.has(entry)).toBe(false);

      tabs.back();
      expect(tabs.activeId).toBe(entry);
      expect(tabs.has(entry)).toBe(true);
      // Permanent, or the next click in the tree would throw it away again.
      expect(tabs.previewId).not.toBe(entry);
    });

    it("records one step per jump, not two", () => {
      const tabs = useTabsStore();
      tabs.openFile("a.yaml");
      tabs.jumpTo("b.yaml", 5, 1);

      tabs.back();
      expect(tabs.activeId).toBe(fileTabId("a.yaml"));
      expect(tabs.canGoBack).toBe(false);
    });

    it("does not record re-activating the tab already in front", () => {
      const tabs = useTabsStore();
      tabs.openFile("a.yaml");
      const id = tabs.openFile("b.yaml");
      tabs.activate(id);
      tabs.activate(id);

      tabs.back();
      expect(tabs.activeId).toBe(fileTabId("a.yaml"));
    });

    it("discards the forward tail once you go somewhere else", () => {
      const tabs = useTabsStore();
      tabs.openFile("a.yaml");
      tabs.openFile("b.yaml");
      tabs.back();
      tabs.openFile("c.yaml");

      expect(tabs.canGoForward).toBe(false);
      tabs.back();
      expect(tabs.activeId).toBe(fileTabId("a.yaml"));
    });

    it("does not record the neighbour a close falls back to", () => {
      const tabs = useTabsStore();
      tabs.openFile("a.yaml");
      const b = tabs.openFile("b.yaml");
      tabs.closeTab(b);
      expect(tabs.activeId).toBe(fileTabId("a.yaml"));

      // Closing is not going somewhere: back should still reach the state
      // before b was opened, which is a.yaml, and stop there.
      expect(tabs.canGoBack).toBe(true);
      tabs.back();
      expect(tabs.activeId).toBe(fileTabId("a.yaml"));
      expect(tabs.canGoBack).toBe(false);
    });

    it("records nothing while a persisted tab set is restored", () => {
      const store = useTabsStore();
      store.setVersion("v1");
      store.openFile("a.yaml");
      store.openFile("b.yaml");
      store.persist();

      setActivePinia(createPinia());
      const restored = useTabsStore();
      restored.setVersion("v1");
      restored.restore("v1");
      expect(restored.canGoBack).toBe(false);
      expect(restored.canGoForward).toBe(false);
    });

    it("forgets a deleted run, which no id can reopen", () => {
      const tabs = useTabsStore();
      tabs.openFile("a.yaml");
      tabs.openRun({ id: "run-1" });
      tabs.closeRun("run-1");

      expect(tabs.canGoBack).toBe(false);
      expect(tabs.activeId).toBe(fileTabId("a.yaml"));
    });

    it("starts over when the model changes", () => {
      const tabs = useTabsStore();
      tabs.setVersion("v1");
      tabs.openFile("a.yaml");
      tabs.openFile("b.yaml");
      tabs.setVersion("v2");

      expect(tabs.canGoBack).toBe(false);
    });
  });

  describe("editor mode", () => {
    it("switches for a section tab", () => {
      const tabs = useTabsStore();
      const id = tabs.openSection("techs", "techs.yaml");
      tabs.setEditorMode(id, "raw");
      expect(tabs.get(id)).toMatchObject({ editorMode: "raw" });
    });

    it("is a no-op for a file tab, which has only one mode", () => {
      const tabs = useTabsStore();
      const id = tabs.openFile("model.yaml");
      tabs.setEditorMode(id, "structured");
      expect(tabs.get(id)).not.toHaveProperty("editorMode");
    });
  });

  describe("saving with no model open", () => {
    // A resolved save reads as success to its caller, which then marks the
    // buffer clean — so with no model open the store must reject, not skip
    // the write.
    it("rejects a YAML save and issues no request", async () => {
      const tabs = useTabsStore();
      await expect(tabs.saveYamlFile("model.yaml", "x: 1")).rejects.toThrow(
        /nothing was saved/
      );
      expect(putFile).not.toHaveBeenCalled();
    });

    it("rejects a CSV save and issues no request", async () => {
      const tabs = useTabsStore();
      await expect(
        tabs.saveCsvFile("t.csv", [{ name: "a", type: "text" }], [["1"]])
      ).rejects.toThrow(/nothing was saved/);
      expect(putCsv).not.toHaveBeenCalled();
    });
  });
});
