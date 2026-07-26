<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import Tree from "primevue/tree";
import Button from "primevue/button";
import type { TreeNode } from "../../stores/version";
import { useVersionStore } from "../../stores/version";
import { useEditorStore } from "../../stores/editor";
import { useComponentTreeStore } from "../../stores/componentTree";
import ImportGraphPanel from "./ImportGraphPanel.vue";

const versionStore = useVersionStore();
const editorStore = useEditorStore();
const componentTreeStore = useComponentTreeStore();

type ExplorerTab = "files" | "model";
const activeTab = ref<ExplorerTab>("model");
const showImportGraph = ref(false);

const fileNodes = computed(() => versionStore.fileTree);

// ---------------------------------------------------------------------------
// Model component tree — convert ComponentTree to PrimeVue TreeNode[]
// ---------------------------------------------------------------------------

interface ModelTreeNode {
  key: string;
  label: string;
  nodeIcon: string;
  leaf: boolean;
  data?: { section: string; file?: string; entryName?: string; template?: string };
  children?: ModelTreeNode[];
}

function sectionIcon(section: string): string {
  const icons: Record<string, string> = {
    config: "pi pi-cog",
    data_tables: "pi pi-table",
    techs: "pi pi-bolt",
    nodes: "pi pi-map-marker",
    links: "pi pi-arrows-h",
    templates: "pi pi-clone",
    overrides: "pi pi-sliders-v",
    scenarios: "pi pi-list",
  };
  return icons[section] ?? "pi pi-folder";
}

const modelNodes = computed<ModelTreeNode[]>(() => {
  const ct = componentTreeStore.tree;
  if (!ct) return [];

  const result: ModelTreeNode[] = [];
  const SECTIONS = ["config", "data_tables", "techs", "nodes", "links", "templates", "overrides", "scenarios"] as const;

  for (const section of SECTIONS) {
    const data = ct[section];
    if (!data) continue;

    if (section === "config") {
      result.push({
        key: "config",
        label: "Config",
        nodeIcon: sectionIcon("config"),
        leaf: true,
        data: { section: "config", file: data.file },
      });
      continue;
    }

    const children: ModelTreeNode[] = (data.entries ?? []).map((entry) => {
      const name = typeof entry === "string" ? entry : entry.name;
      const file = typeof entry === "string" ? data.file : entry.file;
      const template = typeof entry === "string" ? undefined : entry.template;
      return {
        key: `${section}:${name}`,
        label: name,
        nodeIcon: "pi pi-minus",
        leaf: true,
        data: { section, file, entryName: name, template },
      };
    });

    result.push({
      key: section,
      label: section.replace("_", " ").replace(/^\w/, (c) => c.toUpperCase()),
      nodeIcon: sectionIcon(section),
      leaf: children.length === 0,
      children,
      data: { section, file: data.file },
    });
  }
  return result;
});

function switchToModel() {
  activeTab.value = "model";
  if (editorStore.versionId) {
    componentTreeStore.load(editorStore.versionId);
  }
}

onMounted(() => switchToModel());

// The version is set from the route after this panel mounts, so loading only on
// mount left the model tree permanently empty.
watch(
  () => editorStore.versionId,
  (versionId) => {
    if (versionId) componentTreeStore.load(versionId);
  },
  { immediate: true },
);

function refreshModel() {
  if (editorStore.versionId) {
    componentTreeStore.refresh(editorStore.versionId);
  }
}

// ---------------------------------------------------------------------------
// File tree navigation
// ---------------------------------------------------------------------------

function onFileNodeSelect(node: TreeNode) {
  if (!node.leaf) return;
  const type = node.type === "csv" ? "csv" : node.type === "yaml" ? "yaml" : "other";
  editorStore.openTab(node.key, type);
}

// ---------------------------------------------------------------------------
// Model tree navigation — opens file + switches to structured mode + section
// ---------------------------------------------------------------------------

const STRUCTURED_SECTIONS = new Set(["config", "data_tables", "techs", "nodes", "links"]);

function onModelNodeSelect(node: ModelTreeNode) {
  if (!node.data) return;
  const { section, file, entryName } = node.data;
  if (!file) return;

  if (!STRUCTURED_SECTIONS.has(section)) {
    // Sections without a structured editor (overrides, scenarios): open the file in raw YAML
    editorStore.openTab(file, "yaml");
    return;
  }

  if (entryName) {
    editorStore.openEntryTab(section, file, entryName);
  } else {
    editorStore.openSectionTab(section, file);
  }
}
</script>

<template>
  <div class="explorer-panel">
    <!-- Tab bar -->
    <div class="panel-tabs">
      <button
        class="panel-tab"
        :class="{ active: activeTab === 'model' }"
        @click="switchToModel"
      >
        <i class="pi pi-sitemap" />
        Model
      </button>
      <button
        class="panel-tab"
        :class="{ active: activeTab === 'files' }"
        @click="activeTab = 'files'"
      >
        <i class="pi pi-folder" />
        Files
      </button>
    </div>

    <!-- Files tab -->
    <template v-if="activeTab === 'files'">
      <div v-if="versionStore.isLoading" class="panel-placeholder">Loading…</div>
      <div v-else-if="fileNodes.length === 0" class="panel-placeholder">No files found.</div>
      <Tree
        v-else
        :value="fileNodes"
        class="file-tree"
        :pt="{ root: { class: 'file-tree-root' } }"
      >
        <template #default="{ node }: { node: any }">
          <span class="file-node" @click="onFileNodeSelect(node)">
            <i :class="node.fileIcon" />
            <span class="file-name">{{ node.label }}</span>
            <span
              v-if="node.leaf && editorStore.openTabs.get(node.key)?.isDirty"
              class="dirty-dot"
              title="Unsaved changes"
            />
          </span>
        </template>
      </Tree>
    </template>

    <!-- Model tab -->
    <template v-else>
      <div class="model-toolbar">
        <Button
          icon="pi pi-share-alt"
          size="small"
          text
          severity="secondary"
          title="Import graph"
          @click="showImportGraph = true"
        />
        <Button
          icon="pi pi-refresh"
          size="small"
          text
          severity="secondary"
          title="Refresh component tree"
          :loading="componentTreeStore.isLoading"
          @click="refreshModel"
        />
      </div>
      <ImportGraphPanel
        v-if="editorStore.versionId"
        :versionId="editorStore.versionId"
        v-model:visible="showImportGraph"
      />
      <div v-if="componentTreeStore.isLoading" class="panel-placeholder">Loading…</div>
      <div v-else-if="!componentTreeStore.tree || modelNodes.length === 0" class="panel-placeholder">
        No model.yaml found.
      </div>
      <Tree
        v-else
        :value="modelNodes"
        class="file-tree"
        :pt="{ root: { class: 'file-tree-root' } }"
      >
        <template #default="{ node }: { node: any }">
          <span class="file-node" @click="onModelNodeSelect(node)">
            <i :class="node.nodeIcon" />
            <span class="file-name">{{ node.label }}</span>
            <span v-if="node.data?.template" class="template-badge">{{ node.data.template }}</span>
          </span>
        </template>
      </Tree>
    </template>
  </div>
</template>

<style scoped>
.explorer-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  border-right: 1px solid var(--p-content-border-color, #e0e0e0);
  overflow: hidden;
}

.panel-tabs {
  display: flex;
  border-bottom: 1px solid var(--p-content-border-color, #e0e0e0);
  flex-shrink: 0;
}

.panel-tab {
  flex: 1;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 0.4rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
  color: var(--p-text-muted-color, #888);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
}

.panel-tab.active {
  color: var(--p-text-color, #111);
  border-bottom-color: var(--p-primary-color, #6366f1);
}

.model-toolbar {
  display: flex;
  justify-content: flex-end;
  padding: 0.15rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color, #e0e0e0);
  flex-shrink: 0;
}

.panel-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--p-text-muted-color, #888);
  font-size: 0.875rem;
  padding: 1rem;
  text-align: center;
}

.file-tree {
  flex: 1;
  overflow-y: auto;
  padding: 0.25rem 0;
}

:deep(.file-tree-root) {
  border: none;
  padding: 0;
}

:deep(.p-tree-node-content) {
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  cursor: pointer;
}

:deep(.p-tree-node-content:hover) {
  background: var(--p-content-hover-background, rgba(0, 0, 0, 0.06));
}

.file-node {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.875rem;
}

.dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--p-primary-color, #6366f1);
  margin-left: auto;
  flex-shrink: 0;
}

.template-badge {
  font-size: 0.7rem;
  color: var(--p-text-muted-color, #888);
  margin-left: 0.25rem;
  flex-shrink: 0;
}
</style>
