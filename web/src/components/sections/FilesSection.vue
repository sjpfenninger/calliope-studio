<script setup lang="ts">
/**
 * Every file in the workspace, as it is on disk.
 *
 * Unlike the model tree — which is the *merged* picture across the import graph,
 * two levels deep — this is the real directory structure, and clicking a file
 * always opens it raw. The two used to be a pair of buttons inside one panel,
 * invisible to the URL; they are sibling routes now.
 */
import { computed, ref, watch } from "vue";
import { ChevronsDownUp, ChevronsUpDown, SearchX } from "@lucide/vue";

import { Tree } from "@/components/ui/tree";
import InfoTip from "@/components/app/InfoTip.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import TreeSearch from "@/components/app/TreeSearch.vue";
import { useTreeSearch } from "@/composables/useTreeSearch";
import { GHOST_BUTTON } from "@/lib/formClasses";
import { fileIcon } from "@/lib/icons";
import { type FileTreeNode } from "@/lib/fileTree";
import { openIntent } from "@/lib/openIntent";
import { fileTabId } from "@/lib/tabId";
import { useTabsStore } from "@/stores/tabs";
import { useVersionStore } from "@/stores/version";

const tabs = useTabsStore();
const version = useVersionStore();

const selected = ref<FileTreeNode>();
const nodes = computed(() => version.fileTree);

// Matched on the whole relative path rather than the label, so `model/tech`
// narrows: a file's label is only its last segment, and in a tree of `techs.yaml`
// under several directories that is not enough to tell them apart.
const {
  query,
  items: visible,
  expanded,
  isEmpty,
  hasBranches,
  allExpanded,
  toggleAll,
} = useTreeSearch("files", nodes, (node) => node.key, selected);

watch(
  () => tabs.versionId,
  (versionId) => {
    if (versionId) version.loadFileTree(versionId);
  },
  { immediate: true },
);

function open(node: FileTreeNode, event: MouseEvent | KeyboardEvent) {
  // Only leaves are files; a directory just expands.
  if (node.leaf) tabs.openFile(node.key, openIntent(event));
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- A workspace is usually small enough that opening every folder shows the
         whole of it at once, which is faster to read than clicking down to a
         file. One control rather than two, because the two are never both
         useful: whichever the tree is not already in is the one being asked for. -->
    <PanelHeader>
      <button
        type="button"
        data-testid="toggle-folders"
        :class="GHOST_BUTTON"
        :disabled="!hasBranches"
        @click="toggleAll"
      >
        <component :is="allExpanded ? ChevronsDownUp : ChevronsUpDown" class="size-3.5" />
        {{ allExpanded ? "Collapse all" : "Expand all" }}
      </button>
      <div class="flex-1" />
    </PanelHeader>

    <TreeSearch
      v-model="query"
      label="Filter the file tree"
      placeholder="Filter files"
      testid="file-search"
    />

    <!-- Above the tree, not instead of it: the `role="tree"` element stays
         mounted, so every `data-testid` selector keeps resolving, and an empty
         `flex-1` list below the message costs nothing to look at. -->
    <StateMessage v-if="isEmpty" variant="inline" :icon="SearchX">
      No file matches “{{ query }}”
    </StateMessage>

    <Tree
      v-model="selected"
      v-model:expanded="expanded"
      :items="visible"
      :get-key="(node) => (node as FileTreeNode).key"
      :get-children="(node) => (node as FileTreeNode).children"
      :get-label="(node) => (node as FileTreeNode).label"
      :get-icon="
        (node) => fileIcon((node as FileTreeNode).leaf ? ((node as FileTreeNode).type ?? '') : 'directory')
      "
      data-testid="file-tree"
      class="min-h-0 flex-1"
      @select="(node, event) => open(node as FileTreeNode, event)"
    >
      <template #trailing="{ item }">
        <InfoTip
          v-if="tabs.get(fileTabId((item as FileTreeNode).key))?.isDirty"
          label="Unsaved changes"
        >
          <span class="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />
        </InfoTip>
      </template>
    </Tree>
  </div>
</template>
