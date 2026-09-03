<script setup lang="ts">
/**
 * What the active tab shows.
 *
 * A stack of absolutely positioned panes rather than a `v-if` chain, because
 * three of them must not be destroyed when they go to the background:
 *
 * - **Monaco** is a single instance shared by every raw YAML buffer. Each tab
 *   owns a text model; unmounting the component disposes all of them, so a
 *   `v-if` here would silently discard unsaved edits the moment the user looked
 *   at a CSV or a run and came back. `v-show` only.
 * - **Run panes** each hold a MapLibre map and several ECharts instances. One is
 *   rendered per run tab that has ever been in front, so switching back does not
 *   refetch Arrow or rebuild the map. The store caps how many stay live.
 * - **Structured editors** hold the user's unsaved form state in component state
 *   and nowhere else. This was a `v-if` on the *active* tab, so looking at
 *   anything else threw the edits away — and `useSectionEditor.load()` on the
 *   way back re-read the saved section and called `markClean`, taking the dirty
 *   dot with them. One pane per tab that has been shown as a form, `v-show`n,
 *   capped by the store, and a dirty one is never evicted.
 *
 * Absolute positioning also matters for Monaco: its container is driven by a
 * ResizeObserver rather than `automaticLayout`, so returning from `display:none`
 * — zero size to real size — is what triggers its relayout.
 *
 * The root is a **flex column** holding an optional strip above that stack, not
 * the stack itself. A markdown tab has two views of one file and needs somewhere
 * to put the switch; Monaco is `inset-0` and cannot host it. Inset *inside* the
 * inner box, every pane keeps the geometry it had, and Monaco resizes through
 * the observer it already has.
 */
import { computed } from "vue";
import { FileText, Pencil } from "@lucide/vue";

import PanelHeader from "@/components/app/PanelHeader.vue";
import Segmented from "@/components/app/Segmented.vue";
import StateMessage from "@/components/app/StateMessage.vue";

import CsvGridEditor from "@/components/editor/CsvGridEditor.vue";
import FileViewer from "@/components/editor/FileViewer.vue";
import MarkdownView from "@/components/editor/MarkdownView.vue";
import MonacoYamlEditor from "@/components/editor/MonacoYamlEditor.vue";
import RunTabView from "@/components/runs/RunTabView.vue";
import ValidationTabView from "@/components/validation/ValidationTabView.vue";
import MathTabView from "@/components/math/MathTabView.vue";
import StructuredEditorHost from "./StructuredEditorHost.vue";
import { isTextFileType } from "@/lib/fileKind";
import { useTabsStore } from "@/stores/tabs";
import type { EntryTab, FileViewMode, SectionTab } from "@/stores/tabs";

const tabs = useTabsStore();

const active = computed(() => tabs.activeTab);

/** A file tab whose file is not text, and so has no buffer to edit. */
const viewerTab = computed(() => {
  const tab = active.value;
  return tab?.kind === "file" && !isTextFileType(tab.fileType) ? tab : null;
});

const markdownTab = computed(() => {
  const tab = active.value;
  return tab?.kind === "file" && tab.fileType === "markdown" ? tab : null;
});

/**
 * Monaco shows for a raw text buffer: a non-CSV text file, or a raw
 * section/entry.
 *
 * Tested positively against the text types rather than as `!== "csv"`, which is
 * what sent a `.png` to the editor — and then let Ctrl/Cmd+S write a string of
 * replacement characters back over it.
 */
const monacoVisible = computed(() => {
  const tab = active.value;
  if (!tab) return false;
  if (tab.kind === "file") {
    if (tab.fileType === "csv" || !isTextFileType(tab.fileType)) return false;
    return tab.fileType !== "markdown" || tab.viewMode === "raw";
  }
  if (tab.kind === "section" || tab.kind === "entry") return tab.editorMode === "raw";
  return false;
});

const VIEW_MODES = [
  { value: "preview" as const, label: "Preview", icon: FileText, testid: "md-preview" },
  { value: "raw" as const, label: "Source", icon: Pencil, testid: "md-source" },
];

const viewMode = computed<FileViewMode>({
  get: () => markdownTab.value?.viewMode ?? "preview",
  set: (mode) => {
    if (markdownTab.value) tabs.setFileViewMode(markdownTab.value.id, mode);
  },
});

/** Whether a given structured pane is the one on screen. */
function structuredVisible(tab: SectionTab | EntryTab): boolean {
  return tab.id === tabs.activeId && tab.editorMode === "structured";
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col bg-surface">
    <!-- `bg-surface` rather than the chrome tone, and `size="fill"` on the
         control: this strip is the first thing under the tab bar, and a
         `Segmented` in a `PanelHeader` must take the strip's own height. -->
    <PanelHeader v-if="markdownTab" class="bg-surface">
      <Segmented v-model="viewMode" :items="VIEW_MODES" mode="nav" size="fill" />
    </PanelHeader>

    <div class="relative min-h-0 flex-1">
      <StateMessage v-if="!active" variant="fill" class="absolute inset-0">
        Open something from the sidebar to begin.
      </StateMessage>

      <!-- Never v-if: see the note above. -->
      <MonacoYamlEditor
        v-show="monacoVisible"
        :versionId="tabs.versionId"
        class="absolute inset-0"
      />

      <!-- The front grid plus any holding cell edits — `csvTabs`, the same
           rule as `structuredTabs`. This was a `v-if` on the active tab, and
           a grid's edits live in its component state: switching away and
           back reloaded the file, with the dirty dot still on. -->
      <CsvGridEditor
        v-for="tab in tabs.csvTabs"
        v-show="tab.id === tabs.activeId"
        :key="tab.path"
        :versionId="tabs.versionId"
        :filePath="tab.path"
        class="absolute inset-0"
      />

      <!-- Plain `v-if` for both of these: no canvas, no Monaco model, nothing a
           remount would have to rebuild. -->
      <MarkdownView
        v-if="markdownTab && markdownTab.viewMode === 'preview' && tabs.versionId"
        :key="markdownTab.path"
        :versionId="tabs.versionId"
        :path="markdownTab.path"
        class="absolute inset-0"
      />

      <FileViewer
        v-if="viewerTab && tabs.versionId"
        :key="viewerTab.path"
        :versionId="tabs.versionId"
        :path="viewerTab.path"
        :fileType="viewerTab.fileType === 'image' ? 'image' : 'binary'"
        class="absolute inset-0"
      />

      <!-- The front structured pane, plus any holding unsaved edits; see
           `structuredTabs`. This was a plain `v-if` on the *active* tab, and a
           structured editor's unsaved state is component state and nothing
           else — so looking at another tab discarded the user's edits, and the
           remount on the way back re-read the saved section and cleared the
           dirty dot, leaving nothing to say anything had been lost. -->
      <StructuredEditorHost
        v-for="tab in tabs.structuredTabs"
        v-show="structuredVisible(tab)"
        :key="tab.id"
        :tab="tab"
        :versionId="tabs.versionId!"
        class="absolute inset-0"
      />

      <ValidationTabView
        v-if="active?.kind === 'validation'"
        :tab="active"
        class="absolute inset-0 flex"
      />

      <MathTabView
        v-if="active?.kind === 'math' && tabs.versionId"
        :versionId="tabs.versionId"
        class="absolute inset-0 flex"
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
  </div>
</template>
