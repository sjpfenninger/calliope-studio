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
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import * as monaco from "monaco-editor";
import { TriangleAlert } from "@lucide/vue";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { errorDetail } from "../../api/errors";
import { getFile, getYamlSection, putYamlSection } from "../../api/versions";
import {
  applyMonacoTheme,
  monacoFontFamily,
  monacoFontSize,
  monacoLineHeight,
  MONACO_THEME,
} from "../../editor/monacoTheme";
import PanelHeader from "../app/PanelHeader.vue";
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
const ui = useUiStore();
const containerRef = ref<HTMLElement | null>(null);

/**
 * Why the last Cmd+S on this editor failed. Raw tabs have no toolbar and the
 * app has no toast, so this strip is the one place the failure can appear;
 * the buffer with the unsaved edits stays exactly where it is, dirty.
 */
const saveError = ref<string | null>(null);

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
      content = await getFile(props.versionId, path);
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
      tabsStore.markDirty(fileTabId(path));
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
  const content = await getFile(props.versionId, path);
  const model = models.get(path);
  // Re-checked after the await: the user may have started typing meanwhile.
  if (!model || model.isDisposed() || tabsStore.get(fileTabId(path))?.isDirty) return;
  if (model.getValue() === content) return;
  refreshing.add(path);
  try {
    model.setValue(content);
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
        const sectionData = await getYamlSection(props.versionId, filePath, section);
        content = entryName
          ? yamlStringify({ [entryName]: sectionData[entryName] ?? null })
          : yamlStringify(sectionData);
      } catch {
        content = "";
      }
    }

    // Use a virtual:// URI ending in .yaml so monaco-yaml still applies
    const uri = monaco.Uri.parse(`virtual:///${encodeURIComponent(tab.id)}.yaml`);
    const model = monaco.editor.createModel(content, "yaml", uri);

    const disposable = model.onDidChangeContent(() => {
      tabsStore.markDirty(tab.id);
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
  editor.focus();
}

// Save for virtual (section/entry) tabs — reads Monaco content, writes to yaml-section API
async function saveVirtualTab(tab: SectionTab | EntryTab) {
  if (!props.versionId) return;
  const model = models.get(tab.id);
  if (!model) return;

  const { section, filePath } = tab;
  const entryName = tab.kind === "entry" ? tab.entryName : null;
  const currentContent = model.getValue();

  if (entryName) {
    // Read-modify-write: fetch full section, replace this entry, PUT back
    const fullSection = await getYamlSection(props.versionId!, filePath, section);
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
    await putYamlSection(props.versionId!, filePath, section, fullSection);
    sectionDataStore.invalidate(props.versionId!, filePath, section);
  } else {
    // Section tab: parse and PUT the whole section
    const parsed = yamlParse(currentContent);
    await putYamlSection(props.versionId!, filePath, section, parsed ?? {});
    sectionDataStore.invalidate(props.versionId!, filePath, section);
  }
  // A section PUT rewrites the file, so a raw model of it is now stale too.
  sectionDataStore.noteFileWritten(filePath);
  tabsStore.markClean(tab.id);
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

onMounted(() => {
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

  // Cmd/Ctrl+S → save (file tab or virtual tab). `addCommand` discards the
  // returned promise, so without the catch a rejected PUT is an unhandled
  // rejection and the user is told nothing. The failure renders in the strip
  // above the editor — raw tabs have no toolbar to carry it — and the dirty
  // dot stays on, since `markClean` is only reached on success.
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
    const tab = activeMonacoTab.value;
    if (!tab) return;
    saveError.value = null;
    try {
      if (tab.kind === "file") {
        const model = models.get(tab.path);
        if (!model) return;
        await tabsStore.saveYamlFile(tab.path, model.getValue());
        // Invalidate all section caches for this file — Monaco may have changed any section
        if (props.versionId) sectionDataStore.invalidateFile(props.versionId, tab.path);
      } else {
        await saveVirtualTab(tab);
      }
    } catch (caught) {
      saveError.value = errorDetail(caught, "The file could not be saved.");
    }
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
  const ro = (editor as any)?._resizeObserver as ResizeObserver | undefined;
  ro?.disconnect();
  for (const d of changeDisposables.values()) d.dispose();
  for (const m of models.values()) m.dispose();
  editor?.dispose();
});
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <!-- Only for a real file. A section or entry tab is a model-definition
         fragment by construction, so it has nothing to choose. -->
    <!-- `bg-surface`: it is what the active tab opens onto, and Monaco's own
         background below it is that colour too. -->
    <PanelHeader v-if="filePath" size="md" class="bg-surface">
      <SchemaKindPicker :path="filePath" />
    </PanelHeader>
    <!-- Appears only on failure, for file and virtual tabs alike — the latter
         have no header to carry it. Same shape as EditorToolbar's alert, and
         the same testid, so the failure checks find every save surface one way. -->
    <div
      v-if="saveError"
      role="alert"
      data-testid="save-error"
      class="flex items-center gap-1 border-b border-border bg-surface px-2 py-1 text-2xs text-danger-text"
    >
      <TriangleAlert class="size-3 shrink-0" />
      <span class="truncate">{{ saveError }}</span>
    </div>
    <div ref="containerRef" class="monaco-container min-h-0 flex-1" />
  </div>
</template>

<style scoped>
.monaco-container {
  width: 100%;
  overflow: hidden;
}
</style>
