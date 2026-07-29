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
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { getFile, getYamlSection, putYamlSection } from "../../api/versions";
import {
  applyMonacoTheme,
  monacoFontSize,
  monacoLineHeight,
  MONACO_THEME,
} from "../../editor/monacoTheme";
import PanelHeader from "../app/PanelHeader.vue";
import SchemaKindPicker from "./SchemaKindPicker.vue";
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

let editor: monaco.editor.IStandaloneCodeEditor | null = null;
// Map from tab key (or file path) → monaco model
const models = new Map<string, monaco.editor.ITextModel>();
// Track change listener disposables to avoid leaks
const changeDisposables = new Map<string, monaco.IDisposable>();

function langForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "yaml" || ext === "yml") return "yaml";
  return "plaintext";
}

// Create or reuse a model for a real file tab
async function ensureFileModel(path: string): Promise<monaco.editor.ITextModel> {
  if (models.has(path)) return models.get(path)!;

  let content = "";
  if (props.versionId) {
    content = await getFile(props.versionId, path);
  }

  const uri = monaco.Uri.parse(`file:///${path}`);
  const model = monaco.editor.createModel(content, langForPath(path), uri);

  const disposable = model.onDidChangeContent(() => {
    // A file tab's id is derived from its path rather than being it, so this has
    // to be built — passing the bare path used to work only by coincidence.
    tabsStore.markDirty(fileTabId(path));
  });
  changeDisposables.set(path, disposable);
  models.set(path, model);
  return model;
}

// Create or reuse a virtual model for a section/entry tab.
//
// The tab is passed rather than its id: it already carries `section`, `filePath`
// and `entryName` as typed fields, so parsing them back out of the id — which is
// what this used to do — was both redundant and wrong for any name containing a
// colon.
async function ensureVirtualModel(
  tab: SectionTab | EntryTab,
): Promise<monaco.editor.ITextModel> {
  if (models.has(tab.id)) return models.get(tab.id)!;

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
}

async function activateTab(tab: EditableTab | null) {
  if (!editor || !tab) return;

  const model =
    tab.kind === "file"
      ? await ensureFileModel(tab.path)
      : await ensureVirtualModel(tab);

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
    if (parsed && typeof parsed === "object" && entryName in (parsed as object)) {
      fullSection[entryName] = (parsed as Record<string, any>)[entryName];
    }
    await putYamlSection(props.versionId!, filePath, section, fullSection);
    sectionDataStore.invalidate(props.versionId!, filePath, section);
  } else {
    // Section tab: parse and PUT the whole section
    const parsed = yamlParse(currentContent);
    await putYamlSection(props.versionId!, filePath, section, parsed ?? {});
    sectionDataStore.invalidate(props.versionId!, filePath, section);
  }
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
    fontSize: monacoFontSize(),
    lineHeight: monacoLineHeight(),
    lineNumbers: "on",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: "off",
    automaticLayout: false, // driven by ResizeObserver below
  });

  // Cmd/Ctrl+S → save (file tab or virtual tab)
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
    const tab = activeMonacoTab.value;
    if (!tab) return;
    if (tab.kind === "file") {
      const model = models.get(tab.path);
      if (!model) return;
      await tabsStore.saveYamlFile(tab.path, model.getValue());
      // Invalidate all section caches for this file — Monaco may have changed any section
      if (props.versionId) sectionDataStore.invalidateFile(props.versionId, tab.path);
    } else {
      await saveVirtualTab(tab);
    }
  });

  // Drive layout when the container resizes
  const ro = new ResizeObserver(() => editor?.layout());
  ro.observe(containerRef.value);
  (editor as any)._resizeObserver = ro;

  // Activate current tab if already set
  if (activeMonacoTab.value) activateTab(activeMonacoTab.value);
});

// Swap model whenever the effective Monaco tab changes
watch(activeMonacoTab, (tab) => {
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
    <PanelHeader v-if="filePath" size="sm" class="bg-surface">
      <SchemaKindPicker :path="filePath" />
    </PanelHeader>
    <div ref="containerRef" class="monaco-container min-h-0 flex-1" />
  </div>
</template>

<style scoped>
.monaco-container {
  width: 100%;
  overflow: hidden;
}
</style>
