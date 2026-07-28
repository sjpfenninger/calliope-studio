<script setup lang="ts">
/**
 * The model definition: its component tree, and the button that checks it.
 *
 * Validation is *started* here, because it is an act on the model as a whole and
 * this is the model's column, but its results are a tab. They used to be a list
 * pinned under this tree, which put them one navigation away from being gone —
 * and going to Files is precisely what a user does about a validation error.
 *
 * One button, not two. "Validate" and "Deep" looked like two settings of one
 * knob and were a millisecond YAML parse and a minutes-long Calliope build; the
 * server now runs the first and escalates to the second only on a clean parse.
 */
import { computed, ref, watch } from "vue";
import { Badge } from "@/components/ui/badge";
import PanelHeader from "@/components/app/PanelHeader.vue";
import { GHOST_BUTTON, ICON_BUTTON } from "@/lib/formClasses";
import { Loader2, Network, RefreshCw, ShieldCheck } from "@lucide/vue";

import ImportGraphDialog from "@/components/layout/ImportGraphDialog.vue";
import { Tree } from "@/components/ui/tree";
import { sectionIcon } from "@/lib/icons";
import { buildModelTree, STRUCTURED_SECTIONS, type ModelTreeNode } from "@/lib/modelTree";
import { openIntent } from "@/lib/openIntent";
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

function open(node: ModelTreeNode, event: MouseEvent | KeyboardEvent) {
  if (!node.file) return;
  const intent = openIntent(event);

  // Sections with no structured editor — an override is an arbitrary partial
  // model — open as raw YAML instead.
  if (!STRUCTURED_SECTIONS.has(node.section)) {
    tabs.openFile(node.file, intent);
    return;
  }

  if (node.entryName) tabs.openEntry(node.section, node.file, node.entryName, intent);
  else tabs.openSection(node.section, node.file, intent);
}

const validating = computed(
  () => validation.phase === "syntax" || validation.phase === "build",
);

// The tab opens first, so that the build tier — which can run for minutes — has
// somewhere to report from for the whole of that time rather than at the end.
function validate() {
  if (!tabs.versionId) return;
  tabs.openValidation();
  validation.validate(tabs.versionId);
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PanelHeader>
      <button
        type="button"
        title="Parse the YAML, then ask Calliope to build the model"
        data-testid="validate"
        :class="GHOST_BUTTON"
        :disabled="validating || !tabs.versionId"
        @click="validate"
      >
        <component
          :is="validating ? Loader2 : ShieldCheck"
          class="size-3.5"
          :class="validating && 'animate-spin'"
        />
        {{ validating ? "Validating…" : "Validate" }}
      </button>
      <div class="flex-1" />
      <button
        type="button"
        title="Import graph"
        :class="ICON_BUTTON"
        @click="showImportGraph = true"
      >
        <Network class="size-3.5" />
      </button>
      <button
        type="button"
        title="Reload the model tree"
        :class="ICON_BUTTON"
        @click="refresh"
      >
        <RefreshCw class="size-3.5" />
      </button>
    </PanelHeader>

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
      @select="(node, event) => open(node as ModelTreeNode, event)"
    >
      <template #trailing="{ item }">
        <Badge
          v-if="(item as ModelTreeNode).template"
          variant="outline"
          class="ml-auto shrink-0 border-border-subtle px-1 font-normal text-text-faint"
          :title="`From template ${(item as ModelTreeNode).template}`"
        >
          {{ (item as ModelTreeNode).template }}
        </Badge>
        <span
          v-else-if="(item as ModelTreeNode).settingCount"
          class="ml-auto shrink-0 text-2xs tabular-nums text-text-faint"
        >
          {{ (item as ModelTreeNode).settingCount }}
        </span>
      </template>
    </Tree>

    <ImportGraphDialog
      v-if="tabs.versionId"
      v-model:visible="showImportGraph"
      :versionId="tabs.versionId"
    />
  </div>
</template>
