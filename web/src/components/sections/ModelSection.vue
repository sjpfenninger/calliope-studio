<script setup lang="ts">
/**
 * The model definition: its component tree, and whether it is valid.
 *
 * Validation lives here rather than in a panel of its own because an error is a
 * statement *about* the model definition — and putting it in the same column as
 * the tree lets the third splitter panel disappear entirely, which is what gives
 * a run's charts the full width they need.
 */
import { computed, ref, watch } from "vue";
import { Network, RefreshCw, ShieldCheck } from "lucide-vue-next";

import ImportGraphDialog from "@/components/layout/ImportGraphDialog.vue";
import { Tree } from "@/components/ui/tree";
import { ICON_STROKE_WIDTH, sectionIcon } from "@/lib/icons";
import { buildModelTree, STRUCTURED_SECTIONS, type ModelTreeNode } from "@/lib/modelTree";
import { useComponentTreeStore } from "@/stores/componentTree";
import { useTabsStore } from "@/stores/tabs";
import { useValidationStore } from "@/stores/validation";

const tabs = useTabsStore();
const componentTree = useComponentTreeStore();
const validation = useValidationStore();

const showImportGraph = ref(false);
const selected = ref<ModelTreeNode>();

const nodes = computed(() => buildModelTree(componentTree.tree));

// The version arrives from the route after this mounts, so loading only on
// mount leaves the tree permanently empty.
watch(
  () => tabs.versionId,
  (versionId) => {
    if (versionId) componentTree.load(versionId);
  },
  { immediate: true },
);

function refresh() {
  if (tabs.versionId) componentTree.refresh(tabs.versionId);
}

function open(node: ModelTreeNode | undefined) {
  if (!node?.file) return;

  // Sections with no structured editor — an override is an arbitrary partial
  // model — open as raw YAML instead.
  if (!STRUCTURED_SECTIONS.has(node.section)) {
    tabs.openFile(node.file);
    return;
  }

  if (node.entryName) tabs.openEntry(node.section, node.file, node.entryName);
  else tabs.openSection(node.section, node.file);
}

watch(selected, open);

function validate() {
  if (tabs.versionId) validation.validate(tabs.versionId);
}

function validateDeep() {
  if (tabs.versionId) validation.validateDeep(tabs.versionId);
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div
      class="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-panel px-2"
    >
      <button
        type="button"
        title="Validate"
        data-testid="validate"
        class="inline-flex h-6 items-center gap-1.5 rounded-sm px-2 text-sm text-text-dim hover:bg-hover hover:text-foreground"
        @click="validate"
      >
        <ShieldCheck class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
        Validate
      </button>
      <button
        type="button"
        title="Ask Calliope to build the model"
        data-testid="validate-deep"
        class="inline-flex h-6 items-center rounded-sm px-2 text-sm text-text-dim hover:bg-hover hover:text-foreground"
        @click="validateDeep"
      >
        Deep
      </button>
      <div class="flex-1" />
      <button
        type="button"
        title="Import graph"
        class="grid size-6 place-items-center rounded-sm text-text-faint hover:bg-hover hover:text-foreground"
        @click="showImportGraph = true"
      >
        <Network class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
      </button>
      <button
        type="button"
        title="Reload the model tree"
        class="grid size-6 place-items-center rounded-sm text-text-faint hover:bg-hover hover:text-foreground"
        @click="refresh"
      >
        <RefreshCw class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
      </button>
    </div>

    <Tree
      v-model="selected"
      :items="nodes"
      :get-key="(node) => (node as ModelTreeNode).key"
      :get-children="(node) => (node as ModelTreeNode).children"
      :get-label="(node) => (node as ModelTreeNode).label"
      :get-icon="
        (node) =>
          (node as ModelTreeNode).entryName
            ? undefined
            : sectionIcon((node as ModelTreeNode).section)
      "
      data-testid="model-tree"
      class="min-h-0 flex-1"
    >
      <template #trailing="{ item }">
        <span
          v-if="(item as ModelTreeNode).template"
          class="ml-auto shrink-0 rounded-xs bg-muted px-1 text-2xs text-text-faint"
          :title="`From template ${(item as ModelTreeNode).template}`"
        >
          {{ (item as ModelTreeNode).template }}
        </span>
        <span
          v-else-if="(item as ModelTreeNode).settingCount"
          class="ml-auto shrink-0 text-2xs tabular-nums text-text-faint"
        >
          {{ (item as ModelTreeNode).settingCount }}
        </span>
      </template>
    </Tree>

    <!-- Problems, below the tree: both are narrow lists and belong in one column. -->
    <div
      v-if="validation.errors.length"
      data-testid="validation-errors"
      class="max-h-64 shrink-0 overflow-auto border-t border-border"
    >
      <button
        v-for="(problem, index) in validation.errors"
        :key="index"
        type="button"
        class="flex w-full flex-col items-start gap-0.5 border-b border-border-subtle px-2 py-1 text-left hover:bg-hover"
        @click="problem.line != null && tabs.jumpTo(problem.file, problem.line, 1)"
      >
        <span class="flex w-full items-center gap-1 text-2xs text-text-faint">
          <span class="truncate">{{ problem.file }}</span>
          <span v-if="problem.line != null">:{{ problem.line }}</span>
        </span>
        <span class="text-sm text-danger-text">{{ problem.message }}</span>
      </button>
    </div>

    <ImportGraphDialog
      v-if="tabs.versionId"
      v-model:visible="showImportGraph"
      :versionId="tabs.versionId"
    />
  </div>
</template>
