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

import { Tree } from "@/components/ui/tree";
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
  <Tree
    v-model="selected"
    :items="nodes"
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
      <span
        v-if="tabs.get(fileTabId((item as FileTreeNode).key))?.isDirty"
        class="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
        title="Unsaved changes"
      />
    </template>
  </Tree>
</template>
