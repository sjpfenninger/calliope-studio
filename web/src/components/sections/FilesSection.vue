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
import {
  ChevronsDownUp,
  ChevronsUpDown,
  FilePlus,
  FolderPlus,
  SearchX,
} from "@lucide/vue";

import { Tree } from "@/components/ui/tree";
import InfoTip from "@/components/app/InfoTip.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import TreeSearch from "@/components/app/TreeSearch.vue";
import NewFileDialog from "@/components/editor/NewFileDialog.vue";
import { useTreeSearch } from "@/composables/useTreeSearch";
import { GHOST_BUTTON } from "@/lib/formClasses";
import { fileIcon } from "@/lib/icons";
import { allPaths, type FileTreeNode } from "@/lib/fileTree";
import { openIntent } from "@/lib/openIntent";
import { fileTabId } from "@/lib/tabId";
import { ancestorKeys } from "@/lib/treeFilter";
import { useExplorerStore } from "@/stores/explorer";
import { useTabsStore } from "@/stores/tabs";
import { useVersionStore } from "@/stores/version";

const tabs = useTabsStore();
const version = useVersionStore();
const explorer = useExplorerStore();

const nodes = computed(() => version.fileTree);

/**
 * The chosen row, held in the store as a key.
 *
 * This section is a lazily-mounted route component with no `<keep-alive>`, so
 * a local `ref` was thrown away every time the user went to Model or Runs —
 * and where a new file lands is read off it.
 */
const selected = computed<FileTreeNode | undefined>({
  get: () => nodeAt(nodes.value, explorer.selected.files),
  set: (node) => explorer.setSelected("files", node?.key ?? null),
});

const creating = ref<"file" | "folder" | null>(null);

function nodeAt(items: FileTreeNode[], key: string | null): FileTreeNode | undefined {
  if (key === null) return undefined;
  for (const node of items) {
    if (node.key === key) return node;
    const found = nodeAt(node.children ?? [], key);
    if (found) return found;
  }
  return undefined;
}

/**
 * Where a new entry goes: the selected folder, or the folder holding the
 * selected file, or the model root. What an editor does, and the only reading
 * of a selection that does not surprise.
 */
const parent = computed(() => {
  const node = selected.value;
  if (!node) return "";
  if (!node.leaf) return node.key;
  return node.key.split("/").slice(0, -1).join("/");
});

const taken = computed(() => allPaths(nodes.value));

/**
 * Show the new entry rather than merely having made it.
 *
 * `loadFileTree` is the only refresh path there is, and nothing called it after
 * a mutation before now — there were none to call it after.
 */
async function afterCreate(path: string, kind: "file" | "folder") {
  const versionId = tabs.versionId;
  if (!versionId) return;
  await version.loadFileTree(versionId);
  // After the reload, so the ancestors are looked up in the tree that now
  // contains the new entry rather than the one that did not.
  explorer.reveal("files", ancestorKeys(version.fileTree, path));
  // Permanent, not a preview: a file the user deliberately created must not be
  // evicted by the next plain click in the tree.
  if (kind === "file") tabs.openFile(path);
}

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

      <!-- Both label their target, because where a new entry lands depends on
           what is selected and that is not otherwise visible from the strip. -->
      <TooltipButton
        :label="`New file in ${parent || 'the model folder'}…`"
        :icon="FilePlus"
        testid="new-file"
        @click="creating = 'file'"
      />
      <TooltipButton
        :label="`New folder in ${parent || 'the model folder'}…`"
        :icon="FolderPlus"
        testid="new-folder"
        @click="creating = 'folder'"
      />
    </PanelHeader>

    <NewFileDialog
      v-if="tabs.versionId && creating"
      :open="true"
      :versionId="tabs.versionId"
      :kind="creating"
      :parent="parent"
      :taken="taken"
      @update:open="(value) => !value && (creating = null)"
      @created="afterCreate"
    />

    <TreeSearch
      v-model="query"
      label="Filter the file tree"
      placeholder="Filter files"
      testid="file-search"
    />

    <!-- Above the tree, not instead of it: the `role="tree"` element stays
         mounted, so every `data-testid` selector keeps resolving, and an empty
         `flex-1` list below the message costs nothing to look at.

         The store's own docstring says a model whose files cannot be listed
         must not look like one with no files — and then nothing rendered the
         error it set, so it did. -->
    <StateMessage
      v-if="version.error"
      variant="inline"
      tone="danger"
      data-testid="file-tree-error"
    >
      {{ version.error }}
    </StateMessage>
    <StateMessage
      v-else-if="version.isLoading && !nodes.length"
      variant="inline"
      loading
      data-testid="file-tree-loading"
    >
      Reading the model's files…
    </StateMessage>
    <StateMessage v-else-if="isEmpty" variant="inline" :icon="SearchX">
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
