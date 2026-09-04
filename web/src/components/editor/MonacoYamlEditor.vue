<script setup lang="ts">
/**
 * MonacoYamlEditor
 *
 * One persistent Monaco DOM instance. Each open tab gets its own
 * monaco.editor.ITextModel. File tabs use real file URIs fetched from the API.
 * Section and entry tabs use virtual URIs with content fetched from the
 * yaml-section endpoint (entry tabs show only the single named item as YAML).
 *
 * Switching tabs swaps the active model via editor.setModel().
 */
import { computed, reactive, ref, watch, onMounted, onUnmounted } from "vue";
import * as monaco from "monaco-editor";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { errorDetail, isConflict } from "../../api/errors";
import { putYamlSection, readFile, readYamlSection } from "../../api/versions";
import Banner from "../app/Banner.vue";
import LockedBanner from "../app/LockedBanner.vue";
import ProgressHairline from "../app/ProgressHairline.vue";
import { GHOST_BUTTON } from "../../lib/formClasses";
import { useConfirmStore } from "../../stores/confirm";
import {
  applyMonacoTheme,
  monacoFontFamily,
  monacoFontSize,
  monacoLineHeight,
  MONACO_THEME,
} from "../../editor/monacoTheme";
import PanelHeader from "../app/PanelHeader.vue";
import InfoTip from "@/components/app/InfoTip.vue";
import { shortenPath } from "@/lib/format";
import EditorModeSwitch from "./EditorModeSwitch.vue";
import SchemaKindPicker from "./SchemaKindPicker.vue";
import { fileModelUri } from "../../lib/monacoBuffer";
import { fileTabId } from "../../lib/tabId";
import {
  isEditableTab,
  useTabsStore,
  type EditableTab,
  type EntryTab,
  type SectionTab,
} from "../../stores/tabs";
import { useSectionDataStore } from "../../stores/sectionData";
import { useUiStore } from "../../stores/ui";

const props = defineProps<{
  versionId: string | null;
}>();

const tabsStore = useTabsStore();
const sectionDataStore = useSectionDataStore();
const confirm = useConfirmStore();
const ui = useUiStore();
const containerRef = ref<HTMLElement | null>(null);

/**
 * Why the last Cmd+S on this editor failed. Raw tabs have no toolbar and the
 * app has no toast, so this strip is the one place the failure can appear;
 * the buffer with the unsaved edits stays exactly where it is, dirty.
 */
const saveError = ref<string | null>(null);
/** The failure was a stale baseline; the strip then offers a reload. */
const conflict = ref(false);
/**
 * A write is in flight. Holding Cmd+S used to fire a PUT per key repeat, and
 * two writes of one buffer racing to the same file is how the later one's
 * `markClean` came to bless whichever landed last.
 */
const isSaving = ref(false);

/**
 * Files whose bytes were not all UTF-8. The server replaced what it could not
 * decode, so the buffer is a *transcription* and saving it would write U+FFFD
 * over the original bytes. Such a buffer is read-only here.
 */
const lossyFiles = reactive(new Set<string>());

/**
 * Virtual buffers whose section could not be fetched. They were created empty
 * so the tab has something to show, and an empty section saved is a section
 * emptied — so the save refuses until the tab is reopened.
 */
const failedVirtual = new Set<string>();

let editor: monaco.editor.IStandaloneCodeEditor | null = null;
// Map from tab key (or file path) → monaco model
const models = new Map<string, monaco.editor.ITextModel>();
// Track change listener disposables to avoid leaks
const changeDisposables = new Map<string, monaco.IDisposable>();
/**
 * Models still being fetched, so two concurrent asks share one.
 *
 * Both builders below check `models`, then `await` a fetch, then create — and
 * `jumpTo` calls into here *twice* for the same path: `openFile` moves
 * `activeMonacoTab`, and setting `jumpTarget` a line later wakes the reveal
 * watch. Both missed the cache, both fetched, and the second `createModel` threw
 * `Cannot add model because it already exists` from inside a watcher — which
 * killed the reveal before it ran, so a validation problem or a template link
 * opened the right file at line 1 and logged an error nothing surfaced.
 */
const building = new Map<string, Promise<monaco.editor.ITextModel>>();

/** Builds a model at most once per key, however many callers ask at once. */
function shared(
  key: string,
  build: () => Promise<monaco.editor.ITextModel>,
): Promise<monaco.editor.ITextModel> {
  const existing = models.get(key);
  if (existing) return Promise.resolve(existing);
  const inFlight = building.get(key);
  if (inFlight) return inFlight;
  const promise = build().finally(() => building.delete(key));
  building.set(key, promise);
  return promise;
}

function langForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "yaml" || ext === "yml") return "yaml";
  if (ext === "md" || ext === "markdown") return "markdown";
  return "plaintext";
}

// Create or reuse a model for a real file tab
function ensureFileModel(path: string): Promise<monaco.editor.ITextModel> {
  return shared(path, async () => {
    let content = "";
    if (props.versionId) {
      const read = await readFile(props.versionId, path);
      content = read.content;
      sectionDataStore.setRevision(path, read.revision);
      if (read.lossy) lossyFiles.add(path);
      else lossyFiles.delete(path);
    }

    // Through `fileModelUri` so the scheme is written once: the markdown preview
    // reads this same model to render unsaved edits, and would silently fall back
    // to the fetched text if the two ever disagreed.
    const model = monaco.editor.createModel(
      content,
      langForPath(path),
      fileModelUri(path),
    );

    const disposable = model.onDidChangeContent(() => {
      // A programmatic reload from disk is not a user edit.
      if (refreshing.has(path)) return;
      // A file tab's id is derived from its path rather than being it, so this
      // has to be built — passing the bare path used to work only by coincidence.
      tabsStore.markDirty(fileTabId(path), "raw");
    });
    changeDisposables.set(path, disposable);
    models.set(path, model);
    return model;
  });
}

/** Paths whose model is being reloaded from disk, so the change is not "dirty". */
const refreshing = new Set<string>();

/**
 * Reloads a file model after something other than this editor wrote the file —
 * a structured section save, typically. The buffer is what the next raw Cmd+S
 * writes back, so left stale it would revert that save. A dirty buffer holds
 * the user's own edits over the file and is left alone: the two have genuinely
 * diverged, and neither side may silently win.
 */
async function refreshFileModel(path: string): Promise<void> {
  if (!props.versionId || !models.has(path)) return;
  if (tabsStore.get(fileTabId(path))?.isDirty) return;
  const read = await readFile(props.versionId, path);
  const model = models.get(path);
  // Re-checked after the await: the user may have started typing meanwhile.
  if (!model || model.isDisposed() || tabsStore.get(fileTabId(path))?.isDirty) return;
  sectionDataStore.setRevision(path, read.revision);
  if (read.lossy) lossyFiles.add(path);
  else lossyFiles.delete(path);
  if (model.getValue() === read.content) return;
  refreshing.add(path);
  try {
    // An edit operation rather than `setValue`, which discards the undo stack:
    // a reload after somebody else's save must not take away the ability to
    // undo what was typed here before it.
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: read.content }],
      () => null,
    );
  } finally {
    refreshing.delete(path);
  }
}

/**
 * Drops the virtual models a section write on `path` has left behind. Disposal
 * rather than reload: rebuilt on their next activation they fetch fresh
 * content, and a model nobody is looking at needs nothing sooner. Two buffers
 * are kept — the visibly active raw tab, which is the save's own origin, and a
 * dirty one, which holds the user's edits over a file that has now changed
 * underneath them and must stay visible rather than be silently replaced.
 */
function dropStaleVirtualModels(path: string): void {
  for (const tab of tabsStore.ordered) {
    if (!isEditableTab(tab) || tab.kind === "file") continue;
    if (tab.filePath !== path) continue;
    if (tab.id === activeMonacoTab.value?.id || tab.isDirty) continue;
    const model = models.get(tab.id);
    if (!model) continue;
    if (editor?.getModel() === model) editor.setModel(null);
    changeDisposables.get(tab.id)?.dispose();
    changeDisposables.delete(tab.id);
    model.dispose();
    models.delete(tab.id);
  }
}

// Structured saves announce themselves through `fileRevisions`; reload or drop
// the affected buffers as each lands.
const seenRevisions = new Map<string, number>();
watch(
  () => [...sectionDataStore.fileRevisions.entries()],
  (entries) => {
    for (const [path, revision] of entries) {
      if ((seenRevisions.get(path) ?? 0) >= revision) continue;
      seenRevisions.set(path, revision);
      void refreshFileModel(path).catch((caught) =>
        console.error(`Reloading ${path} after an external write failed:`, caught),
      );
      dropStaleVirtualModels(path);
    }
  },
);

// A model whose tab has closed is disposed rather than kept: the buffer holds
// edits nobody can reach any more, and reopening the file must show the disk.
// Closing a dirty tab passes a confirm dialog first, so by the time the tab is
// gone the discard is the user's decision.
watch(
  () => tabsStore.ordered.map((tab) => tab.id).join("\n"),
  () => {
    const live = new Set<string>();
    for (const tab of tabsStore.ordered) {
      if (!isEditableTab(tab)) continue;
      live.add(tab.kind === "file" ? tab.path : tab.id);
    }
    for (const [key, model] of [...models]) {
      if (live.has(key)) continue;
      if (editor?.getModel() === model) editor.setModel(null);
      changeDisposables.get(key)?.dispose();
      changeDisposables.delete(key);
      model.dispose();
      models.delete(key);
    }
  },
);

// Create or reuse a virtual model for a section/entry tab.
//
// The tab is passed rather than its id: it already carries `section`, `filePath`
// and `entryName` as typed fields, so parsing them back out of the id — which is
// what this used to do — was both redundant and wrong for any name containing a
// colon.
function ensureVirtualModel(
  tab: SectionTab | EntryTab,
): Promise<monaco.editor.ITextModel> {
  return shared(tab.id, async () => {
    const { section, filePath } = tab;
    const entryName = tab.kind === "entry" ? tab.entryName : null;

    let content = "";
    if (props.versionId) {
      try {
        const read = await readYamlSection(props.versionId, filePath, section);
        sectionDataStore.setRevision(filePath, read.revision);
        content = entryName
          ? yamlStringify({ [entryName]: read.data[entryName] ?? null })
          : yamlStringify(read.data);
        failedVirtual.delete(tab.id);
      } catch {
        // Shown empty rather than failing the tab, but remembered: a Cmd+S on
        // this buffer used to write `{}` over the whole section.
        content = "";
        failedVirtual.add(tab.id);
      }
    }

    // Use a virtual:// URI ending in .yaml so monaco-yaml still applies
    const uri = monaco.Uri.parse(`virtual:///${encodeURIComponent(tab.id)}.yaml`);
    const model = monaco.editor.createModel(content, "yaml", uri);

    const disposable = model.onDidChangeContent(() => {
      tabsStore.markDirty(tab.id, "raw");
    });
    changeDisposables.set(tab.id, disposable);
    models.set(tab.id, model);
    return model;
  });
}

async function activateTab(tab: EditableTab | null) {
  if (!editor || !tab) return;

  // The build can await a fetch, and the tab can change while it does. The
  // `shared()` de-dupe stopped two builders racing to `createModel` for one
  // path; it does nothing about *which* buffer ends up attached. Clicking an
  // uncached file A and then a cached file B attached B, then attached A when
  // its fetch landed — so the editor showed A's text under tab B, and Cmd+S
  // wrote `models.get(B)`. The displayed file and the saved file were different
  // files, and nothing said so.
  const model =
    tab.kind === "file"
      ? await ensureFileModel(tab.path)
      : await ensureVirtualModel(tab);

  if (activeMonacoTab.value?.id !== tab.id) return;

  editor.setModel(model);
  editor.updateOptions({ readOnly: readOnly.value });
  editor.focus();
}

// Save for virtual (section/entry) tabs — reads Monaco content, writes to yaml-section API
async function saveVirtualTab(tab: SectionTab | EntryTab) {
  if (!props.versionId) return;
  const model = models.get(tab.id);
  if (!model) return;
  if (failedVirtual.has(tab.id)) {
    throw new Error(
      "This section could not be loaded, so the buffer cannot be saved. " +
        "Close the tab and open it again.",
    );
  }

  const { section, filePath } = tab;
  const entryName = tab.kind === "entry" ? tab.entryName : null;
  const currentContent = model.getValue();
  // Compared after the write: an edit typed meanwhile is not on disk, and the
  // tab has to stay dirty for it.
  const version = model.getAlternativeVersionId();

  if (entryName) {
    // Read-modify-write: fetch full section, replace this entry, PUT back —
    // carrying the revision just read, so the write is refused if the file
    // moved between the two.
    const read = await readYamlSection(props.versionId!, filePath, section);
    const fullSection = read.data;
    const parsed = yamlParse(currentContent);
    // A buffer that no longer declares the entry the tab is for cannot be
    // written through this route, and the failure has to be loud. It used to
    // fall through to a PUT of the section exactly as it had just been fetched
    // and then mark the tab clean: renaming `ccgt:` to `ccgt_new:` in the raw
    // view and pressing Cmd+S reported success, changed nothing, and lost the
    // rename at the next tab close.
    if (!parsed || typeof parsed !== "object" || !(entryName in parsed)) {
      throw new Error(
        `This buffer no longer defines "${entryName}". Renaming an entry has to ` +
          `happen in the whole ${section} section, not in one entry's tab.`,
      );
    }
    fullSection[entryName] = (parsed as Record<string, any>)[entryName];
    const revision = await putYamlSection(
      props.versionId!,
      filePath,
      section,
      fullSection,
      read.revision,
    );
    sectionDataStore.setRevision(filePath, revision);
    sectionDataStore.invalidate(props.versionId!, filePath, section);
  } else {
    // Section tab: parse and PUT the whole section. An empty buffer, or one
    // that is not a mapping, is refused: `parsed ?? {}` used to turn it into a
    // write of `{}`, which deletes every entry in the section.
    const parsed = yamlParse(currentContent);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `The buffer is empty or not a mapping, so it cannot replace the ${section} ` +
          "section. Remove entries in the structured editor instead.",
      );
    }
    const revision = await putYamlSection(
      props.versionId!,
      filePath,
      section,
      parsed as Record<string, any>,
      sectionDataStore.revisionOf(filePath),
    );
    sectionDataStore.setRevision(filePath, revision);
    sectionDataStore.invalidate(props.versionId!, filePath, section);
  }
  // A section PUT rewrites the file, so a raw model of it is now stale too.
  sectionDataStore.noteFileWritten(filePath);
  if (model.getAlternativeVersionId() === version) tabsStore.markClean(tab.id, "raw");
}

/**
 * Throws the active buffer away and re-reads it, for a 409, after asking.
 *
 * The file changed under this buffer and the user has to choose between their
 * edits and what landed on disk; nothing chooses for them.
 */
async function reloadActive(): Promise<void> {
  const tab = activeMonacoTab.value;
  if (!tab) return;
  const ok = await confirm.ask({
    title: "Reload from disk?",
    message: "The unsaved edits in this buffer will be lost.",
    confirmLabel: "Reload",
    destructive: true,
  });
  if (!ok) return;
  saveError.value = null;
  conflict.value = false;
  tabsStore.markClean(tab.id, "raw");
  if (tab.kind === "file") {
    await refreshFileModel(tab.path);
    return;
  }
  // A virtual buffer is rebuilt from a fresh fetch rather than patched.
  const model = models.get(tab.id);
  if (model) {
    if (editor?.getModel() === model) editor.setModel(null);
    changeDisposables.get(tab.id)?.dispose();
    changeDisposables.delete(tab.id);
    model.dispose();
    models.delete(tab.id);
  }
  await activateTab(tab);
}

// The tab whose Monaco model should be showing, or null when Monaco is not the
// right editor for it. Reacts to both tab switches and raw/structured toggles.
//
// A tab with no buffer — a run, a validation — returns null, so `setModel` is
// never called for one and the last YAML buffer simply stays attached behind
// `display: none`, which is why switching away and back does not refetch or
// lose undo history.
const activeMonacoTab = computed<EditableTab | null>(() => {
  const tab = tabsStore.activeTab;
  if (!isEditableTab(tab)) return null;
  if (tab.kind === "file") return tab.fileType === "csv" ? null : tab;
  return tab.editorMode === "raw" ? tab : null;
});

/** The workspace path being edited, or null for a virtual section/entry tab. */
const filePath = computed(() =>
  activeMonacoTab.value?.kind === "file" ? activeMonacoTab.value.path : null,
);

/** The section or entry tab whose buffer is showing, or null for a file. */
const virtualTab = computed(() =>
  activeMonacoTab.value && activeMonacoTab.value.kind !== "file"
    ? activeMonacoTab.value
    : null,
);

/** The file the active buffer is over, for a virtual tab as well. */
const activeFile = computed(() => {
  const tab = activeMonacoTab.value;
  return tab ? tabsStore.fileOf(tab) : null;
});

/**
 * Another buffer holds unsaved changes to the active buffer's file — the
 * structured form of this very tab, typically, when it is toggled to Raw with
 * edits pending. The buffer is shown read-only rather than taking edits it
 * would later save over the form's.
 */
const lockOwner = computed(() => {
  const tab = activeMonacoTab.value;
  if (!tab || tabsStore.canEdit(tab.id, "raw")) return null;
  return tabsStore.dirtyOwner(tabsStore.fileOf(tab));
});

const activeLossy = computed(() =>
  activeMonacoTab.value?.kind === "file" && lossyFiles.has(activeMonacoTab.value.path),
);

const readOnly = computed(() => lockOwner.value !== null || activeLossy.value);

watch(readOnly, (value) => editor?.updateOptions({ readOnly: value }));

// Another model: every buffer here belongs to the previous one. Keyed by
// path, they would otherwise answer for the new model's files with the old
// model's text — and Cmd+S would write it there.
watch(
  () => props.versionId,
  (next, previous) => {
    if (previous == null || next === previous) return;
    editor?.setModel(null);
    for (const d of changeDisposables.values()) d.dispose();
    changeDisposables.clear();
    for (const m of models.values()) m.dispose();
    models.clear();
    building.clear();
    failedVirtual.clear();
    lossyFiles.clear();
    if (activeMonacoTab.value) activateTab(activeMonacoTab.value);
  },
);

/**
 * Saves the active buffer, and reports a failure in the strip above the editor.
 *
 * On `window` and gated on the tab in front, not Monaco's own `addCommand`:
 * that bound the shortcut to editor focus, so clicking the tab strip and
 * pressing Cmd+S opened the browser's Save dialog over a dirty file — the
 * exact bug `CsvGridEditor`'s docstring records fixing, in the one editor that
 * still had it. Raw tabs have no toolbar to carry the failure, so the dirty dot
 * stays on and the strip says why; `markClean` is only reached on success.
 *
 * A save is intent to keep, so a previewed tab is promoted once it lands —
 * as typing into one already promotes it.
 */
async function saveActive(): Promise<void> {
  const tab = activeMonacoTab.value;
  if (!tab || isSaving.value) return;
  isSaving.value = true;
  saveError.value = null;
  conflict.value = false;
  try {
    if (lockOwner.value) {
      throw new Error(`${lockOwner.value.title} holds unsaved changes to this file.`);
    }
    if (tab.kind === "file") {
      const model = models.get(tab.path);
      if (!model) return;
      if (lossyFiles.has(tab.path)) {
        throw new Error(
          "This file has bytes that are not UTF-8, so saving it from here would " +
            "write replacement characters over them. Fix the encoding outside the app.",
        );
      }
      const version = model.getAlternativeVersionId();
      // Invalidate all section caches for this file — Monaco may have changed
      // any section. Before the write lands, not after: a form reloading on
      // the write's own signal must not find the stale entry first.
      if (props.versionId) sectionDataStore.invalidateFile(props.versionId, tab.path);
      await tabsStore.saveYamlFile(tab.path, model.getValue());
      // Typed while the write was in flight: not on disk, so still dirty.
      if (model.getAlternativeVersionId() !== version) {
        tabsStore.markDirty(fileTabId(tab.path), "raw");
      }
    } else {
      await saveVirtualTab(tab);
    }
    tabsStore.promote(tab.id);
  } catch (caught) {
    conflict.value = isConflict(caught);
    saveError.value = errorDetail(caught, "The file could not be saved.");
  } finally {
    isSaving.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (!(event.metaKey || event.ctrlKey) || event.key !== "s") return;
  // Only the buffer on screen: every dirty pane in the app listens on `window`.
  const tab = activeMonacoTab.value;
  if (!tab || tabsStore.activeId !== tab.id) return;
  event.preventDefault();
  void saveActive();
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  if (!containerRef.value) return;

  // Defined before `create`, so the editor never paints with a stock theme.
  applyMonacoTheme(ui.mode);

  editor = monaco.editor.create(containerRef.value, {
    model: null,
    theme: MONACO_THEME,
    fontFamily: monacoFontFamily(),
    fontSize: monacoFontSize(),
    lineHeight: monacoLineHeight(),
    lineNumbers: "on",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: "off",
    automaticLayout: false, // driven by ResizeObserver below
  });

  // Drive layout when the container resizes
  const ro = new ResizeObserver(() => editor?.layout());
  ro.observe(containerRef.value);
  (editor as any)._resizeObserver = ro;

  // Activate current tab if already set
  if (activeMonacoTab.value) activateTab(activeMonacoTab.value);
});

// Swap model whenever the effective Monaco tab changes. The save error belongs
// to the buffer it happened in, so it does not follow the user to another tab.
watch(activeMonacoTab, (tab) => {
  saveError.value = null;
  conflict.value = false;
  if (tab) activateTab(tab);
});

// Re-derive the theme's colours from the tokens. `setTheme` is global, so this
// is a redefine-and-apply rather than anything per-instance — which matters,
// because re-creating the editor would dispose every model and take unsaved
// buffers with it.
watch(
  () => ui.revision,
  () => applyMonacoTheme(ui.mode),
);

// Navigate Monaco to a specific line/column when jumpTarget is set
watch(() => tabsStore.jumpTarget, async (target) => {
  if (!target || !editor) return;
  const { path, line, column } = target;
  // `jumpTo` has already opened the tab, so it is there to look up.
  const tab = tabsStore.get(fileTabId(path));
  if (tab?.kind !== "file") return;

  await activateTab(tab);
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column });
  editor.focus();
  tabsStore.jumpTarget = null;
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  const ro = (editor as any)?._resizeObserver as ResizeObserver | undefined;
  ro?.disconnect();
  for (const d of changeDisposables.values()) d.dispose();
  for (const m of models.values()) m.dispose();
  editor?.dispose();
});
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <!-- A file chooses its schema; a section or entry tab is a model-definition
         fragment by construction and has nothing to choose, but it has a form
         to go back to. `lg`, because the picker inside is a 24px control and a
         control is one size below its strip; `surface`, because this is what the
         active tab opens onto and Monaco's own background below is that colour. -->
    <PanelHeader v-if="filePath || virtualTab" size="lg" tone="surface">
      <SchemaKindPicker v-if="filePath" :path="filePath" />
      <EditorModeSwitch v-if="virtualTab" :tab-id="virtualTab.id" class="ml-auto" />
      <!-- The same path `EditorToolbar` shows beside the switch on the form
           side, so flipping to Source moves nothing at the right end of the
           strip. Without it the path vanished on the way over and came back
           on the way back, which read as the toolbar breaking. -->
      <InfoTip v-if="virtualTab" :label="virtualTab.filePath">
        <span data-testid="editor-file" class="min-w-0 truncate text-sm text-text-muted">
          {{ shortenPath(virtualTab.filePath, 2) }}
        </span>
      </InfoTip>
    </PanelHeader>
    <ProgressHairline :active="isSaving" />
    <!-- Appears only on failure, for file and virtual tabs alike — the latter
         have no toolbar to carry it. Same shape as EditorToolbar's alert, and
         the same testid, so the failure checks find every save surface one way. -->
    <Banner v-if="saveError" tone="danger" testid="save-error">
      {{ saveError }}
      <template #action>
        <button
          v-if="conflict"
          type="button"
          data-testid="reload-from-disk"
          :class="GHOST_BUTTON"
          @click="reloadActive"
        >
          Reload
        </button>
      </template>
    </Banner>
    <LockedBanner v-if="lockOwner && activeFile" :owner="lockOwner" :file="activeFile" />
    <Banner v-else-if="activeLossy" tone="warning" testid="lossy-notice">
      Read-only: this file has bytes that are not UTF-8, and saving it from here
      would replace them. Fix the encoding outside the app.
    </Banner>
    <!-- A section or entry tab's buffer is `yamlStringify` of the section's
         *data*, and saving parses it and PUTs that data — so the file's
         comments never appear here, a comment typed here has nowhere on the
         server to go, and the merge keeps the file's own key order whatever
         order the buffer is in. Values, additions and deletions all apply.
         Said out loud because the alternative is a text editor that silently
         drops half of what is typed into it; the file tab beside it, which
         saves its bytes verbatim, sets exactly the opposite expectation. -->
    <Banner v-else-if="virtualTab" testid="section-raw-notice">
      Comments and ordering are not saved from here — this view holds the
      section's data, not the file's text.
    </Banner>
    <div ref="containerRef" class="monaco-container min-h-0 flex-1" />
  </div>
</template>

<style scoped>
.monaco-container {
  width: 100%;
  overflow: hidden;
}
</style>
