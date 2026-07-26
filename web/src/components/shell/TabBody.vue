<script setup lang="ts">
/**
 * What the active tab shows.
 *
 * A stack of absolutely positioned panes rather than a `v-if` chain, because two
 * of them must not be destroyed when they go to the background:
 *
 * - **Monaco** is a single instance shared by every raw YAML buffer. Each tab
 *   owns a text model; unmounting the component disposes all of them, so a
 *   `v-if` here would silently discard unsaved edits the moment the user looked
 *   at a CSV or a run and came back. `v-show` only.
 * - **Run panes** each hold a MapLibre map and several ECharts instances. One is
 *   rendered per run tab that has ever been in front, so switching back does not
 *   refetch Arrow or rebuild the map. The store caps how many stay live.
 *
 * Absolute positioning also matters for Monaco: its container is driven by a
 * ResizeObserver rather than `automaticLayout`, so returning from `display:none`
 * — zero size to real size — is what triggers its relayout.
 */
import { computed } from "vue";

import CsvGridEditor from "@/components/editor/CsvGridEditor.vue";
import MonacoYamlEditor from "@/components/editor/MonacoYamlEditor.vue";
import RunTabView from "@/components/runs/RunTabView.vue";
import StructuredEditorHost from "./StructuredEditorHost.vue";
import { useTabsStore } from "@/stores/tabs";

const tabs = useTabsStore();

const active = computed(() => tabs.activeTab);

/** Monaco shows for a raw YAML buffer: a non-CSV file, or a raw section/entry. */
const monacoVisible = computed(() => {
  const tab = active.value;
  if (!tab) return false;
  if (tab.kind === "file") return tab.fileType !== "csv";
  if (tab.kind === "section" || tab.kind === "entry") return tab.editorMode === "raw";
  return false;
});

const structuredTab = computed(() => {
  const tab = active.value;
  return (tab?.kind === "section" || tab?.kind === "entry") &&
    tab.editorMode === "structured"
    ? tab
    : null;
});
</script>

<template>
  <div class="relative min-h-0 flex-1 bg-surface">
    <p
      v-if="!active"
      class="absolute inset-0 grid place-items-center text-sm text-muted-foreground"
    >
      Open something from the sidebar to begin.
    </p>

    <!-- Never v-if: see the note above. -->
    <MonacoYamlEditor
      v-show="monacoVisible"
      :versionId="tabs.versionId"
      class="absolute inset-0"
    />

    <CsvGridEditor
      v-if="active?.kind === 'file' && active.fileType === 'csv'"
      :key="active.path"
      :versionId="tabs.versionId"
      :filePath="active.path"
      class="absolute inset-0"
    />

    <StructuredEditorHost
      v-if="structuredTab && tabs.versionId"
      :key="structuredTab.id"
      :tab="structuredTab"
      :versionId="tabs.versionId"
      class="absolute inset-0"
    />

    <!-- One live pane per run tab that has ever been fronted, so switching back
         to a run does not refetch its Arrow frames or rebuild its map. -->
    <RunTabView
      v-for="tab in tabs.runTabs.filter((candidate) => candidate.mounted)"
      v-show="tab.id === tabs.activeId"
      :key="tab.id"
      :tab="tab"
      class="absolute inset-0 flex"
    />
  </div>
</template>
