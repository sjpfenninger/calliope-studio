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
import client from "../../api/client";
import {
  applyMonacoTheme,
  MONACO_FONT_SIZE,
  MONACO_LINE_HEIGHT,
  MONACO_THEME,
} from "../../editor/monacoTheme";
import { useEditorStore, tabKind, parseTabKey } from "../../stores/editor";
import { useSectionDataStore } from "../../stores/sectionData";
import { useUiStore } from "../../stores/ui";

const props = defineProps<{
  versionId: string | null;
}>();

const editorStore = useEditorStore();
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
    const res = await client.get<{ content: string }>(
      `/api/versions/${props.versionId}/files/${path}`
    );
    content = res.data.content;
  }

  const uri = monaco.Uri.parse(`file:///${path}`);
  const model = monaco.editor.createModel(content, langForPath(path), uri);

  const disposable = model.onDidChangeContent(() => {
    editorStore.markDirty(path);
  });
  changeDisposables.set(path, disposable);
  models.set(path, model);
  return model;
}

// Create or reuse a virtual model for a section/entry tab
async function ensureVirtualModel(tabKey: string): Promise<monaco.editor.ITextModel> {
  if (models.has(tabKey)) return models.get(tabKey)!;

  const { kind, section, filePath, entryName } = parseTabKey(tabKey);
  let content = "";
  if (props.versionId) {
    try {
      const res = await client.get<{ section: string; data: any }>(
        `/api/versions/${props.versionId}/yaml-section/${filePath}?section=${section}`
      );
      const sectionData = res.data.data ?? {};
      if (kind === "entry" && entryName) {
        content = yamlStringify({ [entryName]: sectionData[entryName] ?? null });
      } else {
        content = yamlStringify(sectionData);
      }
    } catch {
      content = "";
    }
  }

  // Use a virtual:// URI ending in .yaml so monaco-yaml still applies
  const uri = monaco.Uri.parse(`virtual:///${encodeURIComponent(tabKey)}.yaml`);
  const model = monaco.editor.createModel(content, "yaml", uri);

  const disposable = model.onDidChangeContent(() => {
    editorStore.markDirty(tabKey);
  });
  changeDisposables.set(tabKey, disposable);
  models.set(tabKey, model);
  return model;
}

async function activateTab(key: string | null) {
  if (!editor || !key) return;

  let model: monaco.editor.ITextModel;
  if (tabKind(key) === "file") {
    model = await ensureFileModel(key);
  } else {
    model = await ensureVirtualModel(key);
  }

  editor.setModel(model);
  editor.focus();
}

// Save for virtual (section/entry) tabs — reads Monaco content, writes to yaml-section API
async function saveVirtualTab(tabKey: string) {
  if (!props.versionId) return;
  const model = models.get(tabKey);
  if (!model) return;

  const { kind, section, filePath, entryName } = parseTabKey(tabKey);
  const currentContent = model.getValue();

  if (kind === "entry" && entryName) {
    // Read-modify-write: fetch full section, replace this entry, PUT back
    const sectionRes = await client.get<{ section: string; data: any }>(
      `/api/versions/${props.versionId}/yaml-section/${filePath}?section=${section}`
    );
    const fullSection = sectionRes.data.data ?? {};
    const parsed = yamlParse(currentContent);
    if (parsed && typeof parsed === "object" && entryName in (parsed as object)) {
      fullSection[entryName] = (parsed as Record<string, any>)[entryName];
    }
    await client.put(
      `/api/versions/${props.versionId}/yaml-section/${filePath}?section=${section}`,
      { data: fullSection }
    );
    sectionDataStore.invalidate(props.versionId!, filePath, section);
  } else {
    // Section tab: parse and PUT the whole section
    const parsed = yamlParse(currentContent);
    await client.put(
      `/api/versions/${props.versionId}/yaml-section/${filePath}?section=${section}`,
      { data: parsed ?? {} }
    );
    sectionDataStore.invalidate(props.versionId!, filePath, section);
  }
  editorStore.markClean(tabKey);
}

// Derived: the tab key whose Monaco model should be active, or null when irrelevant.
// Reacts to both tab switches and raw/structured mode toggles.
const activeMonacoKey = computed(() => {
  const key = editorStore.activeTabKey;
  if (!key) return null;
  const tab = editorStore.openTabs.get(key);
  if (!tab || tab.editorMode !== "raw" || tab.type === "csv") return null;
  return key;
});

onMounted(() => {
  if (!containerRef.value) return;

  // Defined before `create`, so the editor never paints with a stock theme.
  applyMonacoTheme(ui.mode);

  editor = monaco.editor.create(containerRef.value, {
    model: null,
    theme: MONACO_THEME,
    fontSize: MONACO_FONT_SIZE,
    lineHeight: MONACO_LINE_HEIGHT,
    lineNumbers: "on",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: "off",
    automaticLayout: false, // driven by ResizeObserver below
  });

  // Cmd/Ctrl+S → save (file tab or virtual tab)
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
    const key = editorStore.activeTabKey;
    if (!key) return;
    if (tabKind(key) === "file") {
      const model = models.get(key);
      if (!model) return;
      await editorStore.saveYamlFile(key, model.getValue());
      // Invalidate all section caches for this file — Monaco may have changed any section
      if (props.versionId) sectionDataStore.invalidateFile(props.versionId, key);
    } else {
      await saveVirtualTab(key);
    }
  });

  // Drive layout when the container resizes
  const ro = new ResizeObserver(() => editor?.layout());
  ro.observe(containerRef.value);
  (editor as any)._resizeObserver = ro;

  // Activate current tab if already set
  if (activeMonacoKey.value) {
    activateTab(activeMonacoKey.value);
  }
});

// Swap model whenever the effective Monaco key changes
watch(activeMonacoKey, (key) => {
  if (key !== null) activateTab(key);
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
watch(() => editorStore.jumpTarget, async (target) => {
  if (!target || !editor) return;
  const { path, line, column } = target;
  await activateTab(path);
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column });
  editor.focus();
  editorStore.jumpTarget = null;
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
  <div ref="containerRef" class="monaco-container" />
</template>

<style scoped>
.monaco-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
