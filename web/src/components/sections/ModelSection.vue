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
import InfoTip from "@/components/app/InfoTip.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import TreeSearch from "@/components/app/TreeSearch.vue";
import { GHOST_BUTTON } from "@/lib/formClasses";
import { Loader2, Network, RefreshCw, SearchX, ShieldCheck } from "@lucide/vue";

import ImportGraphDialog from "@/components/layout/ImportGraphDialog.vue";
import { Tree } from "@/components/ui/tree";
import { useTreeSearch } from "@/composables/useTreeSearch";
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

// Matched on the label, which is the row as it is written: an entry's key is
// `techs:ccgt`, so matching that would let `s:c` hit a technology.
const {
  query,
  items: visible,
  expanded,
  isEmpty,
} = useTreeSearch("model", nodes, (node) => node.label, selected);

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
  // model — open as raw YAML instead, at the line the entry is declared on where
  // the server could find one. Landing at line 1 of a file of forty templates is
  // the start of the search, not the end of it, and the provenance markers beside
  // an inherited field navigate the same way.
  if (!STRUCTURED_SECTIONS.has(node.section)) {
    if (node.line != null) tabs.jumpTo(node.file, node.line, 1, intent);
    else tabs.openFile(node.file, intent);
    return;
  }

  if (node.entryName) tabs.openEntry(node.section, node.file, node.entryName, intent);
  else tabs.openSection(node.section, node.file, intent);
}

const validating = computed(
  () => validation.phase === "syntax" || validation.phase === "build",
);

const canValidate = computed(() => !validating.value && !!tabs.versionId);

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
      <!-- The trigger is the wrapper, not the button: a disabled control fires
           no pointer events, so a tooltip on one never opens. It only takes the
           button's place in the tab order while the button is out of it. -->
      <InfoTip label="Parse the YAML, then ask Calliope to build the model">
        <span class="inline-flex" :tabindex="canValidate ? undefined : 0">
          <button
            type="button"
            data-testid="validate"
            :class="GHOST_BUTTON"
            :disabled="!canValidate"
            @click="validate"
          >
            <component
              :is="validating ? Loader2 : ShieldCheck"
              class="size-3.5"
              :class="validating && 'animate-spin'"
            />
            {{ validating ? "Validating…" : "Validate" }}
          </button>
        </span>
      </InfoTip>
      <div class="flex-1" />
      <TooltipButton
        label="Import graph"
        :icon="Network"
        @click="showImportGraph = true"
      />
      <TooltipButton label="Reload the model tree" :icon="RefreshCw" @click="refresh" />
    </PanelHeader>

    <TreeSearch
      v-model="query"
      label="Filter the model tree"
      placeholder="Filter components"
      testid="model-search"
    />

    <!-- Above the tree, not instead of it: the `role="tree"` element stays
         mounted, so every `data-testid` selector keeps resolving. -->
    <StateMessage v-if="isEmpty" variant="inline" :icon="SearchX">
      Nothing in the model matches “{{ query }}”
    </StateMessage>

    <Tree
      v-model="selected"
      v-model:expanded="expanded"
      :items="visible"
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
        <InfoTip
          v-if="(item as ModelTreeNode).template"
          :label="`From template ${(item as ModelTreeNode).template}`"
        >
          <Badge
            variant="outline"
            class="ml-auto shrink-0 border-border-subtle px-1 font-normal text-text-faint"
          >
            {{ (item as ModelTreeNode).template }}
          </Badge>
        </InfoTip>
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
