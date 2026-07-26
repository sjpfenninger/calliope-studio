<script setup lang="ts">
import { computed } from "vue";
import Button from "primevue/button";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import MonacoYamlEditor from "../editor/MonacoYamlEditor.vue";
import CsvGridEditor from "../editor/CsvGridEditor.vue";
import ConfigEditor from "../editor/ConfigEditor.vue";
import DataTablesEditor from "../editor/DataTablesEditor.vue";
import TechsEditor from "../editor/TechsEditor.vue";
import NodesEditor from "../editor/NodesEditor.vue";
import LinksEditor from "../editor/LinksEditor.vue";

const tabsStore = useTabsStore();

// Insertion-ordered; the store hands them over ready to render.
const tabs = computed(() => tabsStore.ordered);

const activeTab = computed(() => tabsStore.activeTab);

/**
 * Whether the active tab is showing a structured editor.
 *
 * Only section and entry tabs have a mode at all: a file is always raw, and a
 * run has no editor. Narrowing on the discriminant says that, where reading a
 * `.editorMode` that half the union does not have could not.
 */
const isStructured = computed(() => {
  const tab = activeTab.value;
  return (
    (tab?.kind === "section" || tab?.kind === "entry") &&
    tab.editorMode === "structured"
  );
});

/** The section/entry tab currently in front, for the structured editors. */
const structuredTab = computed(() => {
  const tab = activeTab.value;
  return (tab?.kind === "section" || tab?.kind === "entry") && isStructured.value
    ? tab
    : null;
});


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

function tabLabel(tab: TabEntry): string {
  // The title is computed once when the tab opens, so the bar stays dumb — but a
  // section reads better title-cased than as its raw key.
  if (tab.kind === "section") {
    return tab.section.replace(/_/g, " ").replace(/^\w/, (c: string) => c.toUpperCase());
  }
  return tab.title;
}

function tabIconClass(tab: TabEntry): string {
  if (tab.kind === "run") return "pi pi-chart-bar";
  if (tab.kind === "file") {
    return tab.fileType === "csv"
      ? "pi pi-table"
      : tab.fileType === "yaml"
        ? "pi pi-file-edit"
        : "pi pi-file";
  }
  return sectionIconClass(tab.section);
}

function selectTab(id: string) {
  // Through the store, not by assigning activeId: activating is what marks a
  // tab mounted and keeps the run-pane LRU honest.
  tabsStore.activate(id);
}

function closeTab(id: string, e: MouseEvent) {
  e.stopPropagation();
  tabsStore.closeTab(id);
}

// ---------------------------------------------------------------------------
// Raw / Structured mode toggle
// ---------------------------------------------------------------------------

function switchToStructured() {
  if (tabsStore.activeId) tabsStore.setEditorMode(tabsStore.activeId, "structured");
}

function switchToRaw() {
  if (tabsStore.activeId) tabsStore.setEditorMode(tabsStore.activeId, "raw");
}
</script>

<template>
  <div class="editor-panel">
    <!-- Tab bar -->
    <div v-if="tabs.length > 0" class="tab-bar">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: tab.id === tabsStore.activeId }"
        @click="selectTab(tab.id)"
      >
        <i :class="tabIconClass(tab)" class="tab-icon" />
        <span class="tab-name">{{ tabLabel(tab) }}</span>
        <span v-if="tab.kind === 'entry'" class="tab-section-suffix">· {{ tab.section }}</span>
        <span v-if="tab.isDirty" class="dirty-indicator" title="Unsaved">●</span>
        <button class="close-btn" @click="closeTab(tab.id, $event)" title="Close">×</button>
      </div>

      <!-- Raw / Structured toggle: only the tabs that have both. A file is
           always raw and a run has no editor at all. -->
      <div
        v-if="activeTab?.kind === 'section' || activeTab?.kind === 'entry'"
        class="mode-toggle"
      >
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
      <!-- Monaco: one persistent instance for every raw YAML buffer, ever.
           `v-show`, never `v-if` — unmounting disposes every model, so a
           `v-if` here would silently discard unsaved edits the moment the user
           looked at a CSV or a run and came back. -->
      <MonacoYamlEditor
        v-show="
          (activeTab?.kind === 'file' && activeTab.fileType !== 'csv') ||
          ((activeTab?.kind === 'section' || activeTab?.kind === 'entry') && !isStructured)
        "
        :versionId="tabsStore.versionId"
        class="editor-fill"
      />

      <!-- CSV editor (file tabs only) -->
      <CsvGridEditor
        v-if="activeTab?.kind === 'file' && activeTab.fileType === 'csv'"
        :key="activeTab.path"
        :versionId="tabsStore.versionId"
        :filePath="activeTab.path"
        class="editor-fill"
      />

      <!-- SECTION / ENTRY tab structured view (section fixed, no sub-tabs).
           `structuredTab` is narrowed to the two kinds that have a section, so
           none of this needs a non-null assertion any more. -->
      <div v-if="structuredTab" class="structured-view section-content">
        <ConfigEditor
          v-if="structuredTab.section === 'config'"
          :versionId="tabsStore.versionId!"
          :filePath="structuredTab.filePath"
          :tabId="structuredTab.id"
        />
        <DataTablesEditor
          v-else-if="structuredTab.section === 'data_tables'"
          :versionId="tabsStore.versionId!"
          :filePath="structuredTab.filePath"
          :tabId="structuredTab.id"
        />
        <TechsEditor
          v-else-if="structuredTab.section === 'techs'"
          :versionId="tabsStore.versionId!"
          :filePath="structuredTab.filePath"
          :tabId="structuredTab.id"
          :entryName="structuredTab.kind === 'entry' ? structuredTab.entryName : null"
        />
        <NodesEditor
          v-else-if="structuredTab.section === 'nodes'"
          :versionId="tabsStore.versionId!"
          :filePath="structuredTab.filePath"
          :tabId="structuredTab.id"
          :entryName="structuredTab.kind === 'entry' ? structuredTab.entryName : null"
        />
        <LinksEditor
          v-else-if="structuredTab.section === 'links'"
          :versionId="tabsStore.versionId!"
          :filePath="structuredTab.filePath"
          :tabId="structuredTab.id"
          :entryName="structuredTab.kind === 'entry' ? structuredTab.entryName : null"
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
