import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";

import { putCsv, putFile } from "../api/versions";
import { KEY_PREFIX } from "../lib/storageKeys";
import {
  entryTabId,
  fileTabId,
  parseTabId,
  runTabId,
  sectionTabId,
  validationTabId,
  type TabKind,
  type TabSpec,
} from "../lib/tabId";

export type FileType = "yaml" | "csv" | "other";
export type EditorMode = "raw" | "structured";
export type RunSubView = "results" | "table" | "config" | "log";

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

export interface ValidationTab extends TabCommon {
  kind: "validation";
  /**
   * Validation results are a statement about the model, not a buffer over it,
   * so this tab can never be dirty. Literal-typed for the same reason `RunTab`
   * is: `markDirty` on it should not compile.
   */
  isDirty: false;
}

export type TabEntry = FileTab | SectionTab | EntryTab | RunTab | ValidationTab;

/** The three kinds that have a buffer and can therefore be saved. */
export type EditableTab = FileTab | SectionTab | EntryTab;

/**
 * Whether a tab has a buffer behind it.
 *
 * A predicate rather than a `kind !== "run"` test at each call site: the kinds
 * that *cannot* be dirty are the growing half of the union — a run is frozen,
 * validation results are a statement about the model — and enumerating them by
 * exclusion means every new one has to remember to add itself to two guards or
 * silently become writable.
 */
export function isEditableTab(
  tab: TabEntry | null | undefined,
): tab is EditableTab {
  return tab != null && EDITABLE_KINDS.has(tab.kind);
}

const EDITABLE_KINDS: ReadonlySet<TabKind> = new Set<TabKind>([
  "file",
  "section",
  "entry",
]);

export interface JumpTarget {
  path: string;
  line: number;
  column: number;
}

/**
 * How an `open*` call should treat the tab it opens.
 *
 * An options bag rather than a positional flag because `openFile` already had a
 * second parameter nobody passed, and a bare `true` at a call site says nothing
 * about what it means.
 */
export interface OpenOptions {
  /** Park the tab in the reusable preview slot. A plain click; not a Cmd-click. */
  preview?: boolean;
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
    case "validation":
      return "Validation";
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

  /**
   * The one tab a plain click is allowed to reuse, if there is one.
   *
   * Browsing a model is mostly *looking*: opening a permanent tab per click
   * filled the bar within a minute of clicking around the tree. So a plain click
   * parks its tab here and evicts whatever was here before, and only a
   * Cmd-click, a double-click or the first edit makes a tab permanent.
   */
  const previewId = ref<string | null>(null);

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

  // ── Persistence ───────────────────────────────────────────────────────────

  /**
   * Per model, because a tab set is about one model's files.
   *
   * Only the ids are stored. They are enough to rebuild every tab — that is the
   * point of `lib/tabId.ts` — and storing anything more would mean persisting a
   * *copy* of state the files themselves already hold, which goes stale the
   * moment the model is edited outside the app.
   */
  const storageKey = (id: string) => `${KEY_PREFIX}tabs.${id}`;

  function persist() {
    if (!versionId.value) return;
    localStorage.setItem(
      storageKey(versionId.value),
      JSON.stringify({ tabs: [...openTabs.keys()], active: activeId.value }),
    );
  }

  /**
   * Reopens the tabs this model had last time, if any are remembered.
   *
   * Returns the id that should come to the front, rather than activating it, so
   * the caller can let a `?tab=` in the URL win — a link to a specific tab has
   * to beat what the last session happened to leave open.
   */
  function restore(id: string): string | null {
    let stored: { tabs?: unknown; active?: unknown };
    try {
      const raw = localStorage.getItem(storageKey(id));
      if (!raw) return null;
      stored = JSON.parse(raw);
    } catch {
      // A corrupt entry is not worth failing to open a model over.
      return null;
    }
    if (!Array.isArray(stored.tabs)) return null;

    quiet = true;
    try {
      for (const tabId of stored.tabs) {
        // An id that no longer parses is skipped, not fatal: these outlive the
        // scheme that wrote them.
        if (typeof tabId === "string") openFromId(tabId);
      }
    } finally {
      quiet = false;
    }

    const active = typeof stored.active === "string" ? stored.active : null;
    return active && openTabs.has(active) ? active : null;
  }

  function get(id: string): TabEntry | undefined {
    return openTabs.get(id);
  }

  function has(id: string): boolean {
    return openTabs.has(id);
  }

  /**
   * Set while restoring a persisted tab set.
   *
   * Every `open*` activates, and activating latches `mounted`. Restoring six
   * tabs would therefore build six panes, five of them inside a hidden
   * container — which is exactly the zero-size MapLibre problem the latch
   * exists to avoid. Restore opens quietly and activates once, at the end.
   */
  let quiet = false;

  function activate(id: string) {
    if (quiet) return;
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

  /**
   * Takes a tab out of the preview slot, so nothing can evict it.
   *
   * Idempotent, and safe to call for a tab that was never previewed — every
   * permanent open goes through it.
   */
  function promote(id: string) {
    if (previewId.value === id) previewId.value = null;
  }

  /**
   * Applies the preview rule to a tab that has just been opened and activated.
   *
   * The order the callers use matters: the new tab is activated *first*, so that
   * closing the outgoing preview here never has to pick a successor. A tab that
   * was already open and permanent stays permanent when it is clicked again —
   * only a fresh open, or the preview slot's own tab, can be a preview. And a
   * dirty preview is never evicted, since that would throw away a buffer the
   * user is part-way through editing.
   */
  function settlePreview(id: string, existed: boolean, preview: boolean) {
    if (!preview || (existed && previewId.value !== id)) {
      promote(id);
      return;
    }
    const prior = previewId.value;
    previewId.value = id;
    if (prior && prior !== id && !openTabs.get(prior)?.isDirty) closeTab(prior);
  }

  function openFile(
    path: string,
    options: OpenOptions & { fileType?: FileType } = {},
  ): string {
    const id = fileTabId(path);
    const existed = openTabs.has(id);
    if (!existed) {
      openTabs.set(id, {
        id,
        kind: "file",
        title: titleFor({ kind: "file", path }),
        path,
        fileType: options.fileType ?? fileTypeOf(path),
        isDirty: false,
        mounted: false,
      });
    }
    activate(id);
    settlePreview(id, existed, options.preview ?? false);
    return id;
  }

  function openSection(
    section: string,
    filePath: string,
    options: OpenOptions = {},
  ): string {
    const id = sectionTabId(section, filePath);
    const existed = openTabs.has(id);
    if (!existed) {
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
    settlePreview(id, existed, options.preview ?? false);
    return id;
  }

  function openEntry(
    section: string,
    filePath: string,
    entryName: string,
    options: OpenOptions = {},
  ): string {
    const id = entryTabId(section, filePath, entryName);
    const existed = openTabs.has(id);
    if (!existed) {
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
    settlePreview(id, existed, options.preview ?? false);
    return id;
  }

  function openRun(
    run: {
      id: string | null;
      handle?: string | null;
      label?: string | null;
    },
    options: OpenOptions = {},
  ): string {
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
    settlePreview(id, existing !== undefined, options.preview ?? false);
    return id;
  }

  /**
   * Opens the validation tab, always permanently.
   *
   * Deliberately takes no `OpenOptions`. Validating is an explicit action, and
   * the preview slot is emptied by the next plain click in the model tree —
   * which is exactly what a user does while working through the problems this
   * tab lists. A previewed validation tab would close itself on the first click
   * it caused.
   */
  function openValidation(): string {
    const id = validationTabId();
    const existed = openTabs.has(id);
    if (!existed) {
      openTabs.set(id, {
        id,
        kind: "validation",
        title: titleFor({ kind: "validation" }),
        isDirty: false,
        mounted: false,
      });
    }
    activate(id);
    settlePreview(id, existed, false);
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
      case "validation":
        return openValidation();
    }
  }

  // ── Editing state ─────────────────────────────────────────────────────────

  function markDirty(id: string) {
    const tab = openTabs.get(id);
    if (isEditableTab(tab)) {
      tab.isDirty = true;
      // Editing is intent to keep: a previewed file the user has started typing
      // in must not be evicted by the next click in the tree.
      promote(id);
    }
  }

  function markClean(id: string) {
    const tab = openTabs.get(id);
    if (isEditableTab(tab)) tab.isDirty = false;
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
    if (previewId.value === id) previewId.value = null;
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
    // A single click on a validation problem, so it previews like every other.
    openFile(path, { preview: true });
    jumpTarget.value = { path, line, column };
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  async function saveYamlFile(path: string, content: string): Promise<void> {
    if (!versionId.value) return;
    await putFile(versionId.value, path, content);
    markClean(fileTabId(path));
  }

  async function saveCsvFile(
    path: string,
    columns: Array<{ name: string; type: string }>,
    rows: unknown[][],
  ): Promise<void> {
    if (!versionId.value) return;
    await putCsv(versionId.value, path, columns, rows);
    markClean(fileTabId(path));
  }

  return {
    openTabs,
    activeId,
    previewId,
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
    persist,
    restore,
    activate,
    openFile,
    openSection,
    openEntry,
    openRun,
    openValidation,
    openFromId,
    promote,
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
