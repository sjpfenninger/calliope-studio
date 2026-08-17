import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";

import { putCsv, putFile } from "../api/versions";
import { fileKindOf, isTextFileType, type FileType } from "../lib/fileKind";
import {
  canGoBack as historyCanGoBack,
  canGoForward as historyCanGoForward,
  currentEntry,
  emptyHistory,
  forget,
  stepBack,
  stepForward,
  visit,
  type NavAnchor,
  type NavEntry,
  type NavHistory,
} from "../lib/navHistory";
import { KEY_PREFIX } from "../lib/storageKeys";
import {
  entryTabId,
  fileTabId,
  parseTabId,
  runTabId,
  sectionTabId,
  mathTabId,
  validationTabId,
  type TabKind,
  type TabSpec,
} from "../lib/tabId";

export type { FileType };
export type EditorMode = "raw" | "structured";
/** Markdown is text, so it is edited as well as read. */
export type FileViewMode = "raw" | "preview";
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
  /**
   * Only markdown has two views of itself, so only markdown reads this.
   *
   * Deliberately not on `TabCommon`: a YAML file has one view, and a field that
   * is meaningless for five of six file types invites a switch that forgets one.
   */
  viewMode: FileViewMode;
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

export interface MathTab extends TabCommon {
  kind: "math";
  /**
   * The math is a reading of the model, not a buffer over it — a user math file
   * is edited in its own file tab, in Monaco, against Calliope's math schema.
   * Literal-typed for the same reason `RunTab` and `ValidationTab` are:
   * `markDirty` on it should not compile.
   */
  isDirty: false;
}

export type TabEntry =
  | FileTab
  | SectionTab
  | EntryTab
  | RunTab
  | ValidationTab
  | MathTab;

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
 *
 * **A file tab is editable only if its file is text**, which is the second axis
 * and the one that closes a real hole. A `.png` is `kind: "file"` like any
 * other, so it passed this predicate, Monaco built a text model over a string of
 * replacement characters, and Ctrl/Cmd+S wrote that back over the image. Both
 * axes are allow-lists for the same reason: what must not be written is the
 * growing half of both.
 */
export function isEditableTab(
  tab: TabEntry | null | undefined,
): tab is EditableTab {
  if (tab == null || !EDITABLE_KINDS.has(tab.kind)) return false;
  return tab.kind !== "file" || isTextFileType(tab.fileType);
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

/**
 * Markdown opens rendered.
 *
 * A README is written to be read; someone who wants the source can ask for it,
 * and the toggle is right there. Every other kind has one view.
 */
function viewModeFor(fileType: FileType): FileViewMode {
  return fileType === "markdown" ? "preview" : "raw";
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
    case "math":
      return "Math";
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
   * Where the user has been, for the back and forward buttons.
   *
   * In memory only. A session's history is not a preference — persisting it
   * would mean a second storage key whose entries name tabs the model may no
   * longer contain, restored into a window nobody has navigated in yet.
   */
  const history = ref<NavHistory>(emptyHistory());

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
    // The stack names this model's tabs, so it does not survive a change of
    // model — back would otherwise offer to reopen a file that is not here.
    if (versionId.value !== id) history.value = emptyHistory();
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

  /**
   * Set while an activation is not the user going somewhere.
   *
   * Every `open*` funnels through `activate`, which is what lets the history be
   * recorded in one place with no call site knowing about it — and is also why
   * the exceptions have to say so, or walking backwards would append to the very
   * stack it is walking.
   */
  let replaying = false;

  /**
   * Runs `body` without recording the activations it causes.
   *
   * Saves and restores rather than clearing the flag, because these nest: a
   * replayed open can settle the preview slot, which closes a tab, which
   * activates its neighbour. A `finally` that wrote `false` would hand the outer
   * replay back an unsuppressed `activate` and quietly record half of it.
   */
  function withoutRecording<T>(body: () => T): T {
    const was = replaying;
    replaying = true;
    try {
      return body();
    } finally {
      replaying = was;
    }
  }

  /**
   * Brings a tab to the front, recording it as somewhere the user has been.
   *
   * `anchor` is set only by `jumpTo`: the position is what makes going *forward*
   * to a provenance link land where it landed the first time, since `jumpTarget`
   * is a one-shot signal Monaco nulls after consuming and the cursor is stored
   * nowhere else.
   */
  function activate(id: string, anchor: NavAnchor | null = null) {
    if (quiet) return;
    const tab = openTabs.get(id);
    if (!tab) return;
    tab.mounted = true;
    activeId.value = id;

    const at = recency.indexOf(id);
    if (at >= 0) recency.splice(at, 1);
    recency.push(id);
    dropStaleRunPanes();

    if (!replaying) history.value = visit(history.value, { tabId: id, anchor });
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

  /**
   * `anchor` is deliberately here rather than on the shared `OpenOptions`: a
   * position only means anything for a file, and putting it on the bag
   * `openIntent` returns would have the other four `open*` accept and ignore it.
   */
  function openFile(
    path: string,
    options: OpenOptions & { fileType?: FileType; anchor?: NavAnchor } = {},
  ): string {
    const id = fileTabId(path);
    const existed = openTabs.has(id);
    if (!existed) {
      const fileType = options.fileType ?? fileKindOf(path);
      openTabs.set(id, {
        id,
        kind: "file",
        title: titleFor({ kind: "file", path }),
        path,
        fileType,
        viewMode: viewModeFor(fileType),
        isDirty: false,
        mounted: false,
      });
    }
    activate(id, options.anchor ?? null);
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
   * Opens the Math tab, always permanently.
   *
   * No `OpenOptions`, for the same reason `openValidation` takes none: rendering
   * the math is an explicit action that takes seconds, and the preview slot is
   * emptied by the next plain click in the model tree — which is exactly what a
   * user does next, since the Math group's rows are what open this.
   */
  function openMath(): string {
    const id = mathTabId();
    const existed = openTabs.has(id);
    if (!existed) {
      openTabs.set(id, {
        id,
        kind: "math",
        title: titleFor({ kind: "math" }),
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
      case "math":
        return openMath();
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

  function setFileViewMode(id: string, mode: FileViewMode) {
    const tab = openTabs.get(id);
    if (tab?.kind === "file") tab.viewMode = mode;
  }

  function setSubView(id: string, view: RunSubView) {
    const tab = openTabs.get(id);
    if (tab?.kind !== "run") return;
    tab.subView = view;
    if (!tab.seenViews.includes(view)) tab.seenViews.push(view);
  }

  /**
   * Moves a tab to `toIndex`, which is a position in the bar as it is now.
   *
   * The Map is rebuilt rather than kept alongside an order array. Insertion order
   * *is* the bar's order — `ordered`, `persist` and `closeTab`'s neighbour walk
   * all read it straight off the Map — so a second source of truth would be a
   * second thing to keep in step, and the entries are the same objects either
   * way, so nothing a tab is carrying is disturbed by the move.
   *
   * Persistence needs no help: `AppShell` watches the joined key list, which a
   * reorder changes.
   */
  function moveTab(id: string, toIndex: number) {
    const entries = [...openTabs.entries()];
    const from = entries.findIndex(([key]) => key === id);
    if (from < 0) return;

    const to = Math.max(0, Math.min(entries.length - 1, toIndex));
    if (to === from) return;

    entries.splice(to, 0, ...entries.splice(from, 1));
    openTabs.clear();
    for (const [key, tab] of entries) openTabs.set(key, tab);
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
    // Not a step: the neighbour is where closing left you, not somewhere you
    // went. Recording it would put the closed tab's successor into the stack
    // twice over and make "back" mean "undo a close".
    if (next) withoutRecording(() => activate(next));
    else activeId.value = null;
  }

  /**
   * Closes a run's tab, if it has one. For a run that has just been deleted.
   *
   * The one case where history is discarded rather than kept. Every other closed
   * tab is reopenable from its id — which is what makes going back to a tab the
   * preview slot evicted work at all — but a deleted run is gone from disk, and
   * `openFromId` would happily conjure a tab for it.
   */
  function closeRun(runId: string) {
    const id = runTabId(runId);
    history.value = forget(history.value, id);
    if (openTabs.has(id)) closeTab(id);
  }

  /**
   * Opens a file tab and asks Monaco to reveal a position in it.
   *
   * Previews by default, as a single click on a validation problem should. The
   * options are for a caller with a real click in hand — a provenance marker
   * naming the template a value comes from — so that Cmd-click pins the tab here
   * exactly as it does everywhere else.
   */
  function jumpTo(
    path: string,
    line: number,
    column: number,
    options: OpenOptions = { preview: true },
  ) {
    // The anchor goes in with the open, so one navigation records one entry
    // rather than a bare landing followed by a positioned one — which would
    // cost two presses of Back to undo one click.
    openFile(path, { ...options, anchor: { line, column } });
    jumpTarget.value = { path, line, column };
  }

  // ── Back and forward ──────────────────────────────────────────────────────

  const canGoBack = computed(() => historyCanGoBack(history.value));
  const canGoForward = computed(() => historyCanGoForward(history.value));

  /**
   * Puts the user back at a place they have been.
   *
   * The tab may not be open any more — closed by hand, or evicted from the
   * preview slot by the very navigation being undone, which is the case this
   * whole feature exists for. Its id rebuilds it, and `openFromId` opens it
   * *permanently*: going back is a deliberate act, and a previewed tab would be
   * thrown away again by the next click in the tree.
   */
  function goTo(entry: NavEntry) {
    const landed = withoutRecording(() => {
      if (!openTabs.has(entry.tabId)) return openFromId(entry.tabId);
      activate(entry.tabId);
      return entry.tabId;
    });
    if (!landed) return;

    const spec = parseTabId(entry.tabId);
    if (entry.anchor && spec?.kind === "file") {
      jumpTarget.value = { path: spec.path, ...entry.anchor };
    }
  }

  function back() {
    const next = stepBack(history.value);
    if (next === history.value) return;
    history.value = next;
    const entry = currentEntry(next);
    if (entry) goTo(entry);
  }

  function forward() {
    const next = stepForward(history.value);
    if (next === history.value) return;
    history.value = next;
    const entry = currentEntry(next);
    if (entry) goTo(entry);
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
    canGoBack,
    canGoForward,
    back,
    forward,
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
    openMath,
    openFromId,
    promote,
    updateRun,
    closeRun,
    markDirty,
    markClean,
    setEditorMode,
    setFileViewMode,
    setSubView,
    moveTab,
    closeTab,
    jumpTo,
    saveYamlFile,
    saveCsvFile,
  };
});

export type { TabKind };
