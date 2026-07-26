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
import { fileTabId } from "@/lib/tabId";
import { useTabsStore } from "@/stores/tabs";
import { useVersionStore, type TreeNode } from "@/stores/version";

const tabs = useTabsStore();
const version = useVersionStore();

const selected = ref<TreeNode>();
const nodes = computed(() => version.fileTree);

watch(
  () => tabs.versionId,
  (versionId) => {
    if (versionId) version.loadFileTree(versionId);
  },
  { immediate: true },
);

watch(selected, (node) => {
  // Only leaves are files; a directory just expands.
  if (node?.leaf) tabs.openFile(node.key);
});
</script>

<template>
  <Tree
    v-model="selected"
    :items="nodes"
    :get-key="(node) => (node as TreeNode).key"
    :get-children="(node) => (node as TreeNode).children"
    :get-label="(node) => (node as TreeNode).label"
    :get-icon="
      (node) => fileIcon((node as TreeNode).leaf ? ((node as TreeNode).type ?? '') : 'directory')
    "
    data-testid="file-tree"
    class="min-h-0 flex-1"
  >
    <template #trailing="{ item }">
      <span
        v-if="tabs.get(fileTabId((item as TreeNode).key))?.isDirty"
        class="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
        title="Unsaved changes"
      />
    </template>
  </Tree>
</template>
