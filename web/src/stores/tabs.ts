import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";

import client from "../api/client";
import {
  entryTabId,
  fileTabId,
  parseTabId,
  runTabId,
  sectionTabId,
  type TabKind,
  type TabSpec,
} from "../lib/tabId";

export type FileType = "yaml" | "csv" | "other";
export type EditorMode = "raw" | "structured";
export type RunSubView = "results" | "config" | "log";

interface TabCommon {
  /** Stable, URL-safe identity. See lib/tabId.ts. */
  id: string;
  /** What the tab bar shows. Precomputed, so the bar stays dumb. */
  title: string;
  /**
   * Set the first time a tab comes to the front, and never unset.
   *
   * The tab body renders one live pane per *activated* tab and shows the front
   * one, so an ECharts instance or a MapLibre map is not rebuilt on every tab
   * switch. Tabs that have never been in front are never mounted at all.
   */
  mounted: boolean;
}

export interface FileTab extends TabCommon {
  kind: "file";
  path: string;
  fileType: FileType;
  isDirty: boolean;
}

export interface SectionTab extends TabCommon {
  kind: "section";
  section: string;
  filePath: string;
  editorMode: EditorMode;
  isDirty: boolean;
}

export interface EntryTab extends TabCommon {
  kind: "entry";
  section: string;
  filePath: string;
  entryName: string;
  editorMode: EditorMode;
  isDirty: boolean;
}

export interface RunTab extends TabCommon {
  kind: "run";
  /** Null when a bare results file was opened rather than a run started here. */
  runId: string | null;
  /** Null until the run has produced results. */
  handle: string | null;
  subView: RunSubView;
  /**
   * Which sub-views have ever been in front.
   *
   * The same latch as `mounted`, one level down. The results pane builds a map
   * and three ECharts instances, and building either inside a `display: none`
   * pane gives it a zero-size container — MapLibre in particular then fits its
   * bounds to nothing. So a sub-view's pane is created the first time it is
   * shown, and `v-show`n from then on.
   */
  seenViews: RunSubView[];
  /**
   * A run is frozen, so it can never be dirty. The literal type — rather than
   * `boolean` — is what makes `markDirty` on a run tab a compile error, while
   * still letting the tab bar read `tab.isDirty` across the whole union.
   */
  isDirty: false;
}

export type TabEntry = FileTab | SectionTab | EntryTab | RunTab;

/** The three kinds that have a buffer and can therefore be saved. */
export type EditableTab = FileTab | SectionTab | EntryTab;

export interface JumpTarget {
  path: string;
  line: number;
  column: number;
}

/** How many run panes stay live before the least recently fronted is dropped. */
const MAX_LIVE_RUN_PANES = 4;

function fileTypeOf(path: string): FileType {
  if (path.endsWith(".csv")) return "csv";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  return "other";
}

function titleFor(spec: TabSpec, hint?: string): string {
  switch (spec.kind) {
    case "file":
      return spec.path.split("/").pop() ?? spec.path;
    case "section":
      return spec.section;
    case "entry":
      return spec.entryName;
    case "run":
      return hint ?? (spec.runId ? `Run ${spec.runId.slice(0, 8)}` : "Results");
  }
}

/**
 * Every open tab, and which one is in front.
 *
 * This is the de facto navigation store for the whole application: a run opens
 * in the same tab bar as a YAML file, so "what am I looking at" is one question
 * with one answer rather than one per half of the app.
 *
 * Replaces `stores/editor.ts`, whose `TabEntry` was a flat struct with
 * `section`, `filePath` and `entryName` set to `""` for tabs that have no such
 * thing — which is why its consumers were full of non-null assertions and
 * kind-checks written as string comparisons on the key.
 */
export const useTabsStore = defineStore("tabs", () => {
  /** Insertion-ordered; the tab bar renders it as-is. */
  const openTabs = reactive(new Map<string, TabEntry>());
  const activeId = ref<string | null>(null);
  const versionId = ref<string | null>(null);
  const jumpTarget = ref<JumpTarget | null>(null);

  /** Most recently fronted last. Bounds how many run panes stay live. */
  const recency: string[] = [];

  const ordered = computed(() => [...openTabs.values()]);
  const activeTab = computed<TabEntry | null>(() =>
    activeId.value ? (openTabs.get(activeId.value) ?? null) : null,
  );
  const hasDirtyTabs = computed(() => ordered.value.some((tab) => tab.isDirty));
  const runTabs = computed(() =>
    ordered.value.filter((tab): tab is RunTab => tab.kind === "run"),
  );

  /**
   * The path of the active tab, but only when it is a *file* tab.
   *
   * Narrowing on the discriminant rather than inspecting the key's prefix, which
   * is what the previous store had to do.
   */
  const activeFilePath = computed(() =>
    activeTab.value?.kind === "file" ? activeTab.value.path : null,
  );

  function setVersion(id: string) {
    versionId.value = id;
  }

  function get(id: string): TabEntry | undefined {
    return openTabs.get(id);
  }

  function has(id: string): boolean {
    return openTabs.has(id);
  }

  function activate(id: string) {
    const tab = openTabs.get(id);
    if (!tab) return;
    tab.mounted = true;
    activeId.value = id;

    const at = recency.indexOf(id);
    if (at >= 0) recency.splice(at, 1);
    recency.push(id);
    dropStaleRunPanes();
  }

  /**
   * Tears down the least recently fronted run panes beyond the cap.
   *
   * Each live run pane is a MapLibre map plus several ECharts instances, so a
   * long session of comparing runs would otherwise accumulate them all. Only
   * `mounted` is cleared — the tab stays open and its filters, which live in a
   * separate per-handle store, survive, so re-fronting it restores the view and
   * only refetches the frames.
   */
  function dropStaleRunPanes() {
    const liveRuns = recency.filter(
      (id) => openTabs.get(id)?.kind === "run" && openTabs.get(id)?.mounted,
    );
    for (const id of liveRuns.slice(0, -MAX_LIVE_RUN_PANES)) {
      const tab = openTabs.get(id);
      if (tab && id !== activeId.value) tab.mounted = false;
    }
  }

  // ── Opening ───────────────────────────────────────────────────────────────

  function openFile(path: string, fileType: FileType = fileTypeOf(path)): string {
    const id = fileTabId(path);
    if (!openTabs.has(id)) {
      openTabs.set(id, {
        id,
        kind: "file",
        title: titleFor({ kind: "file", path }),
        path,
        fileType,
        isDirty: false,
        mounted: false,
      });
    }
    activate(id);
    return id;
  }

  function openSection(section: string, filePath: string): string {
    const id = sectionTabId(section, filePath);
    if (!openTabs.has(id)) {
      openTabs.set(id, {
        id,
        kind: "section",
        title: titleFor({ kind: "section", section, filePath }),
        section,
        filePath,
        editorMode: "structured",
        isDirty: false,
        mounted: false,
      });
    }
    activate(id);
    return id;
  }

  function openEntry(section: string, filePath: string, entryName: string): string {
    const id = entryTabId(section, filePath, entryName);
    if (!openTabs.has(id)) {
      openTabs.set(id, {
        id,
        kind: "entry",
        title: titleFor({ kind: "entry", section, filePath, entryName }),
        section,
        filePath,
        entryName,
        editorMode: "structured",
        isDirty: false,
        mounted: false,
      });
    }
    activate(id);
    return id;
  }

  function openRun(run: {
    id: string | null;
    handle?: string | null;
    label?: string | null;
  }): string {
    const id = runTabId(run.id, run.handle ?? null);
    const existing = openTabs.get(id);

    if (existing?.kind === "run") {
      // A run that has since finished now has a handle; the open tab has to pick
      // it up, or it would keep showing the log with no way to reach the charts.
      if (run.handle) existing.handle = run.handle;
      if (run.label) existing.title = run.label;
    } else {
      const subView: RunSubView = run.handle ? "results" : "log";
      openTabs.set(id, {
        id,
        kind: "run",
        title: titleFor(
          { kind: "run", runId: run.id, handle: run.handle ?? null },
          run.label ?? undefined,
        ),
        runId: run.id,
        handle: run.handle ?? null,
        // With no results yet there is nothing to plot, so the log is the only
        // thing worth showing.
        subView,
        seenViews: [subView],
        isDirty: false,
        mounted: false,
      });
    }
    activate(id);
    return id;
  }

  /**
   * Folds a run's current state into its tab, if it has one open.
   *
   * Called by the runs store on every poll. A run tab is opened the instant the
   * run starts, so it exists long before there are results; picking the handle
   * up here is what lets it stop showing the log and start showing charts. The
   * sub-view only moves when it is still on the log — a user who has gone to
   * look at the frozen config should not be yanked away from it mid-read.
   */
  function updateRun(
    runId: string,
    state: { handle?: string | null; label?: string | null },
  ) {
    const tab = openTabs.get(runTabId(runId));
    if (tab?.kind !== "run") return;

    if (state.label) tab.title = state.label;
    if (state.handle && state.handle !== tab.handle) {
      tab.handle = state.handle;
      if (tab.subView === "log") setSubView(tab.id, "results");
    }
  }

  /** Reopens a tab from an id, as a `?tab=` value or persisted state supplies it. */
  function openFromId(id: string): string | null {
    const spec = parseTabId(id);
    if (!spec) return null;
    switch (spec.kind) {
      case "file":
        return openFile(spec.path);
      case "section":
        return openSection(spec.section, spec.filePath);
      case "entry":
        return openEntry(spec.section, spec.filePath, spec.entryName);
      case "run":
        return openRun({ id: spec.runId, handle: spec.handle });
    }
  }

  // ── Editing state ─────────────────────────────────────────────────────────

  function markDirty(id: string) {
    const tab = openTabs.get(id);
    if (tab && tab.kind !== "run") tab.isDirty = true;
  }

  function markClean(id: string) {
    const tab = openTabs.get(id);
    if (tab && tab.kind !== "run") tab.isDirty = false;
  }

  function setEditorMode(id: string, mode: EditorMode) {
    const tab = openTabs.get(id);
    if (tab && (tab.kind === "section" || tab.kind === "entry")) {
      tab.editorMode = mode;
    }
  }

  function setSubView(id: string, view: RunSubView) {
    const tab = openTabs.get(id);
    if (tab?.kind !== "run") return;
    tab.subView = view;
    if (!tab.seenViews.includes(view)) tab.seenViews.push(view);
  }

  /**
   * Closes a tab, activating its right-hand neighbour and then its left.
   *
   * The previous store jumped to whatever happened to be *last* in the map, so
   * closing a tab in the middle threw the user to the far end of the bar.
   */
  function closeTab(id: string) {
    const ids = [...openTabs.keys()];
    const at = ids.indexOf(id);

    openTabs.delete(id);
    const stale = recency.indexOf(id);
    if (stale >= 0) recency.splice(stale, 1);

    if (activeId.value !== id) return;
    const next = ids[at + 1] ?? ids[at - 1] ?? null;
    if (next) activate(next);
    else activeId.value = null;
  }

  /** Closes a run's tab, if it has one. For a run that has just been deleted. */
  function closeRun(runId: string) {
    const id = runTabId(runId);
    if (openTabs.has(id)) closeTab(id);
  }

  /** Opens a file tab and asks Monaco to reveal a position in it. */
  function jumpTo(path: string, line: number, column: number) {
    openFile(path);
    jumpTarget.value = { path, line, column };
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  async function saveYamlFile(path: string, content: string): Promise<void> {
    if (!versionId.value) return;
    await client.put(`/api/versions/${versionId.value}/files/${path}`, { content });
    markClean(fileTabId(path));
  }

  async function saveCsvFile(
    path: string,
    columns: Array<{ name: string; type: string }>,
    rows: unknown[][],
  ): Promise<void> {
    if (!versionId.value) return;
    await client.put(`/api/versions/${versionId.value}/csv/${path}`, { columns, rows });
    markClean(fileTabId(path));
  }

  return {
    openTabs,
    activeId,
    activeTab,
    activeFilePath,
    ordered,
    hasDirtyTabs,
    runTabs,
    versionId,
    jumpTarget,
    get,
    has,
    setVersion,
    activate,
    openFile,
    openSection,
    openEntry,
    openRun,
    openFromId,
    updateRun,
    closeRun,
    markDirty,
    markClean,
    setEditorMode,
    setSubView,
    closeTab,
    jumpTo,
    saveYamlFile,
    saveCsvFile,
  };
});

export type { TabKind };
