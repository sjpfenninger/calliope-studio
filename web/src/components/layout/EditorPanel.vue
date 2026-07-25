<script setup lang="ts">
import { computed } from "vue";
import Button from "primevue/button";
import { useEditorStore, type TabEntry } from "../../stores/editor";
import MonacoYamlEditor from "../editor/MonacoYamlEditor.vue";
import CsvGridEditor from "../editor/CsvGridEditor.vue";
import ConfigEditor from "../editor/ConfigEditor.vue";
import DataTablesEditor from "../editor/DataTablesEditor.vue";
import TechsEditor from "../editor/TechsEditor.vue";
import NodesEditor from "../editor/NodesEditor.vue";
import LinksEditor from "../editor/LinksEditor.vue";

const editorStore = useEditorStore();

// All open tabs as ordered entries
const tabs = computed(() => [...editorStore.openTabs.entries()]);

// The active tab entry (works for any kind)
const activeTab = computed(() => {
  const k = editorStore.activeTabKey;
  return k ? editorStore.openTabs.get(k) : undefined;
});

const isStructured = computed(
  () => activeTab.value?.editorMode === "structured"
);


// ---------------------------------------------------------------------------
// Section icon helper
// ---------------------------------------------------------------------------

const SECTION_ICONS: Record<string, string> = {
  config: "pi pi-cog",
  data_tables: "pi pi-table",
  techs: "pi pi-bolt",
  nodes: "pi pi-map-marker",
  links: "pi pi-arrows-h",
  overrides: "pi pi-sliders-v",
  scenarios: "pi pi-list",
};

function sectionIconClass(section: string): string {
  return SECTION_ICONS[section] ?? "pi pi-folder";
}

// ---------------------------------------------------------------------------
// Tab bar helpers
// ---------------------------------------------------------------------------

function tabLabel(key: string, tab: TabEntry): string {
  if (tab.kind === "file") return key.split("/").pop() ?? key;
  if (tab.kind === "section") {
    return tab.section.replace(/_/g, " ").replace(/^\w/, (c: string) => c.toUpperCase());
  }
  return tab.entryName;
}

function tabIconClass(tab: TabEntry): string {
  if (tab.kind === "file") {
    return tab.type === "csv"
      ? "pi pi-table"
      : tab.type === "yaml"
        ? "pi pi-file-edit"
        : "pi pi-file";
  }
  return sectionIconClass(tab.section);
}

function selectTab(key: string) {
  editorStore.activeTabKey = key;
}

function closeTab(key: string, e: MouseEvent) {
  e.stopPropagation();
  editorStore.closeTab(key);
}

// ---------------------------------------------------------------------------
// Raw / Structured mode toggle
// ---------------------------------------------------------------------------

function switchToStructured() {
  const key = editorStore.activeTabKey;
  if (!key) return;
  editorStore.setEditorMode(key, "structured");
}

function switchToRaw() {
  const key = editorStore.activeTabKey;
  if (!key) return;
  editorStore.setEditorMode(key, "raw");
}
</script>

<template>
  <div class="editor-panel">
    <!-- Tab bar -->
    <div v-if="tabs.length > 0" class="tab-bar">
      <div
        v-for="[key, tab] in tabs"
        :key="key"
        class="tab"
        :class="{ active: key === editorStore.activeTabKey }"
        @click="selectTab(key)"
      >
        <i :class="tabIconClass(tab)" class="tab-icon" />
        <span class="tab-name">{{ tabLabel(key, tab) }}</span>
        <span v-if="tab.kind === 'entry'" class="tab-section-suffix">· {{ tab.section }}</span>
        <span v-if="tab.isDirty" class="dirty-indicator" title="Unsaved">●</span>
        <button class="close-btn" @click="closeTab(key, $event)" title="Close">×</button>
      </div>

      <!-- Raw / Structured toggle (section/entry tabs only; file tabs are always raw) -->
      <div v-if="activeTab?.kind !== 'file'" class="mode-toggle">
        <Button
          label="Raw"
          size="small"
          :severity="!isStructured ? 'primary' : 'secondary'"
          :text="isStructured"
          @click="switchToRaw"
        />
        <Button
          label="Structured"
          size="small"
          :severity="isStructured ? 'primary' : 'secondary'"
          :text="!isStructured"
          @click="switchToStructured"
        />
      </div>
    </div>

    <!-- Empty state -->
    <div v-if="tabs.length === 0" class="panel-placeholder">
      Open a file to begin.
    </div>

    <!-- Editor area -->
    <div v-else class="editor-content">
      <!-- Monaco: one persistent instance for all tab types in raw mode -->
      <MonacoYamlEditor
        v-show="activeTab?.type !== 'csv' && (activeTab?.kind === 'file' || !isStructured)"
        :versionId="editorStore.versionId"
        class="editor-fill"
      />

      <!-- CSV editor (file tabs only) -->
      <CsvGridEditor
        v-if="activeTab?.kind === 'file' && activeTab?.type === 'csv' && editorStore.activeFilePath"
        :key="editorStore.activeFilePath"
        :versionId="editorStore.versionId"
        :filePath="editorStore.activeFilePath"
        class="editor-fill"
      />

      <!-- SECTION / ENTRY tab structured view (section fixed, no sub-tabs) -->
      <div
        v-if="(activeTab?.kind === 'section' || activeTab?.kind === 'entry') && isStructured"
        class="structured-view section-content"
      >
        <ConfigEditor
          v-if="activeTab?.section === 'config'"
          :versionId="editorStore.versionId!"
          :filePath="activeTab!.filePath"
          :tabKey="editorStore.activeTabKey!"
        />
        <DataTablesEditor
          v-else-if="activeTab?.section === 'data_tables'"
          :versionId="editorStore.versionId!"
          :filePath="activeTab!.filePath"
          :tabKey="editorStore.activeTabKey!"
        />
        <TechsEditor
          v-else-if="activeTab?.section === 'techs'"
          :versionId="editorStore.versionId!"
          :filePath="activeTab!.filePath"
          :tabKey="editorStore.activeTabKey!"
          :entryName="activeTab?.kind === 'entry' ? activeTab.entryName : null"
        />
        <NodesEditor
          v-else-if="activeTab?.section === 'nodes'"
          :versionId="editorStore.versionId!"
          :filePath="activeTab!.filePath"
          :tabKey="editorStore.activeTabKey!"
          :entryName="activeTab?.kind === 'entry' ? activeTab.entryName : null"
        />
        <LinksEditor
          v-else-if="activeTab?.section === 'links'"
          :versionId="editorStore.versionId!"
          :filePath="activeTab!.filePath"
          :tabKey="editorStore.activeTabKey!"
          :entryName="activeTab?.kind === 'entry' ? activeTab.entryName : null"
        />
        <div v-else class="structured-placeholder">
          No structured editor available for this section.
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.tab-bar {
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  flex-shrink: 0;
  border-bottom: 1px solid var(--p-content-border-color, #e0e0e0);
  background: var(--p-surface-50, #f9fafb);
}

.tab {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
  cursor: pointer;
  border-right: 1px solid var(--p-content-border-color, #e0e0e0);
  white-space: nowrap;
  user-select: none;
  color: var(--p-text-muted-color, #666);
}

.tab.active {
  background: var(--p-surface-0, #fff);
  color: var(--p-text-color, #111);
  border-bottom: 2px solid var(--p-primary-color, #6366f1);
}

.tab-icon {
  font-size: 0.75rem;
}

.tab-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-section-suffix {
  font-size: 0.7rem;
  color: var(--p-text-muted-color, #999);
  flex-shrink: 0;
}

.dirty-indicator {
  color: var(--p-primary-color, #6366f1);
  font-size: 0.65rem;
}

.close-btn {
  background: none;
  border: none;
  padding: 0 0.1rem;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  color: inherit;
  opacity: 0.5;
}

.close-btn:hover {
  opacity: 1;
}

.mode-toggle {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  margin-left: auto;
  flex-shrink: 0;
}

.panel-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--p-text-muted-color, #888);
  font-size: 0.875rem;
}

.editor-content {
  flex: 1;
  overflow: hidden;
  position: relative;
}

.editor-fill {
  position: absolute;
  inset: 0;
}

.structured-view {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.structured-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--p-text-muted-color, #888);
  font-size: 0.875rem;
}

.section-content {
  flex: 1;
  overflow: auto;
}
</style>
