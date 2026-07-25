import { ref, reactive, computed } from "vue";
import { defineStore } from "pinia";
import client from "../api/client";

export type FileType = "yaml" | "csv" | "other";
export type EditorMode = "raw" | "structured";
export type TabKind = "file" | "section" | "entry";

export interface TabEntry {
  kind: TabKind;
  isDirty: boolean;
  editorMode: EditorMode;
  // file tabs:
  type: FileType;
  // section + entry tabs:
  section: string;
  filePath: string; // underlying source file
  // entry tabs only:
  entryName: string;
}

export interface JumpTarget {
  path: string;
  line: number;
  column: number;
}

// ---------------------------------------------------------------------------
// Tab key helpers — exported so components can import without coupling to store
// ---------------------------------------------------------------------------

/** Key for a section tab (all entries in one section of a file). */
export function sectionTabKey(section: string, filePath: string): string {
  return `\0s:${section}:${filePath}`;
}

/** Key for an entry tab (single named item inside a section). */
export function entryTabKey(section: string, filePath: string, entryName: string): string {
  return `\0e:${section}:${filePath}:${entryName}`;
}

/** Determine the kind of a tab from its key. File paths never start with \0. */
export function tabKind(key: string): TabKind {
  if (key.startsWith("\0e:")) return "entry";
  if (key.startsWith("\0s:")) return "section";
  return "file";
}

/** Parse any tab key into its constituent parts. */
export function parseTabKey(key: string): {
  kind: TabKind;
  section: string;
  filePath: string;
  entryName: string;
} {
  if (key.startsWith("\0e:")) {
    // \0e:{section}:{filePath}:{entryName}
    const rest = key.slice(3);
    const firstColon = rest.indexOf(":");
    const section = rest.slice(0, firstColon);
    const remainder = rest.slice(firstColon + 1);
    const lastColon = remainder.lastIndexOf(":");
    const filePath = remainder.slice(0, lastColon);
    const entryName = remainder.slice(lastColon + 1);
    return { kind: "entry", section, filePath, entryName };
  }
  if (key.startsWith("\0s:")) {
    // \0s:{section}:{filePath}
    const rest = key.slice(3);
    const firstColon = rest.indexOf(":");
    const section = rest.slice(0, firstColon);
    const filePath = rest.slice(firstColon + 1);
    return { kind: "section", section, filePath, entryName: "" };
  }
  return { kind: "file", section: "", filePath: key, entryName: "" };
}

// ---------------------------------------------------------------------------

export const useEditorStore = defineStore("editor", () => {
  // Map<tabKey, TabEntry> — reactive so components react to dirty-flag changes.
  const openTabs = reactive(new Map<string, TabEntry>());
  // activeTabKey is the primary reactive state for which tab is open.
  const activeTabKey = ref<string | null>(null);
  const versionId = ref<string | null>(null);
  const jumpTarget = ref<JumpTarget | null>(null);

  // Backward-compatible computed: returns the file path only when a FILE tab is active.
  // All existing consumers of editorStore.activeFilePath continue to work correctly.
  const activeFilePath = computed(() => {
    const k = activeTabKey.value;
    return k && tabKind(k) === "file" ? k : null;
  });

  function setVersion(vid: string) {
    versionId.value = vid;
  }

  // ── File tab ────────────────────────────────────────────────────────────────

  function openTab(path: string, type: FileType) {
    if (!openTabs.has(path)) {
      openTabs.set(path, {
        kind: "file",
        isDirty: false,
        type,
        editorMode: "raw",
        section: "",
        filePath: path,
        entryName: "",
      });
    }
    activeTabKey.value = path;
  }

  // ── Section tab (all entries in one section of a file) ─────────────────────

  function openSectionTab(section: string, filePath: string) {
    const key = sectionTabKey(section, filePath);
    if (!openTabs.has(key)) {
      openTabs.set(key, {
        kind: "section",
        isDirty: false,
        type: "yaml",
        editorMode: "structured",
        section,
        filePath,
        entryName: "",
      });
    }
    activeTabKey.value = key;
  }

  // ── Entry tab (single named item) ──────────────────────────────────────────

  function openEntryTab(section: string, filePath: string, entryName: string) {
    const key = entryTabKey(section, filePath, entryName);
    if (!openTabs.has(key)) {
      openTabs.set(key, {
        kind: "entry",
        isDirty: false,
        type: "yaml",
        editorMode: "structured",
        section,
        filePath,
        entryName,
      });
    }
    activeTabKey.value = key;
  }

  // ── Shared actions (work for any tab kind) ──────────────────────────────────

  function markDirty(tabKey: string) {
    const tab = openTabs.get(tabKey);
    if (tab) tab.isDirty = true;
  }

  function markClean(tabKey: string) {
    const tab = openTabs.get(tabKey);
    if (tab) tab.isDirty = false;
  }

  function closeTab(tabKey: string) {
    openTabs.delete(tabKey);
    if (activeTabKey.value === tabKey) {
      const keys = [...openTabs.keys()];
      activeTabKey.value = keys.length > 0 ? keys[keys.length - 1] : null;
    }
  }

  function setEditorMode(tabKey: string, mode: EditorMode) {
    const tab = openTabs.get(tabKey);
    if (tab) tab.editorMode = mode;
  }

  /** Navigate Monaco to a specific line/column in a file tab. */
  function jumpTo(path: string, line: number, column: number) {
    const type: FileType = path.endsWith(".csv")
      ? "csv"
      : path.endsWith(".yaml") || path.endsWith(".yml")
        ? "yaml"
        : "other";
    if (!openTabs.has(path)) {
      openTabs.set(path, {
        kind: "file",
        isDirty: false,
        type,
        editorMode: "raw",
        section: "",
        filePath: path,
        entryName: "",
      });
    }
    activeTabKey.value = path;
    jumpTarget.value = { path, line, column };
  }

  // Called by MonacoYamlEditor on Ctrl/Cmd+S for FILE tabs.
  async function saveYamlFile(path: string, content: string): Promise<void> {
    if (!versionId.value) return;
    await client.put(`/api/versions/${versionId.value}/files/${path}`, { content });
    markClean(path);
  }

  // Called by CsvGridEditor on save.
  async function saveCsvFile(
    path: string,
    columns: Array<{ name: string; type: string }>,
    rows: unknown[][]
  ): Promise<void> {
    if (!versionId.value) return;
    await client.put(`/api/versions/${versionId.value}/csv/${path}`, { columns, rows });
    markClean(path);
  }

  return {
    openTabs,
    activeTabKey,
    activeFilePath,
    versionId,
    jumpTarget,
    setVersion,
    openTab,
    openSectionTab,
    openEntryTab,
    markDirty,
    markClean,
    closeTab,
    setEditorMode,
    jumpTo,
    saveYamlFile,
    saveCsvFile,
  };
});
