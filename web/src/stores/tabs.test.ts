import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { entryTabId, fileTabId, runTabId, sectionTabId } from "../lib/tabId";
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

  describe("jumping", () => {
    it("opens the file and records where to reveal", () => {
      const tabs = useTabsStore();
      tabs.jumpTo("model.yaml", 12, 3);

      expect(tabs.activeFilePath).toBe("model.yaml");
      expect(tabs.jumpTarget).toEqual({ path: "model.yaml", line: 12, column: 3 });
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
});
