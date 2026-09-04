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
import { shortenPath } from "@/lib/format";
import { GHOST_BUTTON, NEUTRAL_BADGE, WARNING_BADGE } from "@/lib/formClasses";
import { cn } from "@/lib/utils";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Loader2,
  Network,
  RefreshCw,
  SearchX,
  ShieldCheck,
} from "@lucide/vue";

import ImportGraphDialog from "@/components/layout/ImportGraphDialog.vue";
import { Tree } from "@/components/ui/tree";
import { useTreeSearch } from "@/composables/useTreeSearch";
import { sectionIcon } from "@/lib/icons";
import { buildModelTree, STRUCTURED_SECTIONS, type ModelTreeNode } from "@/lib/modelTree";
import { openIntent } from "@/lib/openIntent";
import { useComponentTreeStore } from "@/stores/componentTree";
import { useExplorerStore } from "@/stores/explorer";
import { useMathStore } from "@/stores/math";
import { useTabsStore } from "@/stores/tabs";
import { useValidationStore } from "@/stores/validation";

const tabs = useTabsStore();
const componentTree = useComponentTreeStore();
const explorer = useExplorerStore();
const validation = useValidationStore();
const math = useMathStore();

const showImportGraph = ref(false);

const nodes = computed(() => buildModelTree(componentTree.tree));

function nodeAt(items: ModelTreeNode[], key: string | null): ModelTreeNode | undefined {
  if (key === null) return undefined;
  for (const node of items) {
    if (node.key === key) return node;
    const found = nodeAt(node.children ?? [], key);
    if (found) return found;
  }
  return undefined;
}

/**
 * The chosen row, held in the store as a key.
 *
 * A local `ref` here died on every section switch — this is a lazily-mounted
 * route component with no `<keep-alive>` — which among other things left
 * `useTreeSearch`'s reveal watch with nothing to reveal.
 */
const selected = computed<ModelTreeNode | undefined>({
  get: () => nodeAt(nodes.value, explorer.selected.model),
  set: (node) => explorer.setSelected("model", node?.key ?? null),
});

// Matched on the label, which is the row as it is written: an entry's key is
// `techs:ccgt`, so matching that would let `s:c` hit a technology.
const {
  query,
  items: visible,
  expanded,
  isEmpty,
  hasBranches,
  allExpanded,
  toggleAll,
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
  // Math first, because it is the one group whose rows do not open a file. A
  // math *source* is a name: `base` and any mode math live inside the installed
  // Calliope and have nothing in the workspace to open, and even a user's own
  // file is more usefully met as rendered notation than as YAML — which the tab
  // then links back to. Clicking the group itself clears the filter.
  if (node.section === "math") {
    math.focusSource(node.entryName ?? null);
    tabs.openMath();
    return;
  }

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

/**
 * The badge beside a math source, if it has anything to say.
 *
 * Three things are worth a word here and nothing else is. "Not enabled" is the
 * silent failure — declared in `math_paths`, missing from `extra_math`, and so
 * read by nobody. "Missing" is a path that is not on disk. "Replaces base" is a
 * user file that has taken a built-in name, which substitutes itself for that
 * whole math file with only a log line from Calliope to say so.
 */
function mathNote(
  node: ModelTreeNode,
): { text: string; label: string; tone: "warning" | "muted" } | null {
  if (node.section !== "math" || !node.entryName) return null;
  if (node.missing) {
    return {
      text: "missing",
      label: "This file is declared in config.init.math_paths but is not on disk.",
      tone: "warning",
    };
  }
  if (!node.applied) {
    return {
      text: "not enabled",
      label:
        "Declared in config.init.math_paths but not listed in config.init.extra_math, " +
        "so Calliope does not read it.",
      tone: "warning",
    };
  }
  if (node.shadowsBuiltin) {
    return {
      text: "replaces base",
      label: `This file has taken the built-in name "${node.entryName}", so it is used instead of Calliope's own.`,
      tone: "warning",
    };
  }
  if (node.mathKind === "unknown") {
    return {
      text: "undefined",
      label:
        "Listed in config.init.extra_math but not declared in config.init.math_paths. " +
        "Calliope will refuse to read this model.",
      tone: "warning",
    };
  }
  return null;
}

const validating = computed(() => validation.isRunning);

const canValidate = computed(() => !validating.value && !!tabs.versionId);

// The wrapper below keeps a disabled button's tooltip reachable precisely so
// it can say why; a static label over a dead button wastes that.
const validateTip = computed(() =>
  !tabs.versionId
    ? "No model is open."
    : validating.value
      ? "Validation is already running."
      : "Parse the YAML, then ask Calliope to build the model.",
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
      <!-- The trigger is the wrapper, not the button: a disabled control fires
           no pointer events, so a tooltip on one never opens. It only takes the
           button's place in the tab order while the button is out of it. -->
      <InfoTip :label="validateTip">
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
      <!-- What the file tree beside it has had all along; `useTreeSearch`
           returned it for both and only one rendered it. Icon-only where Files
           spells it out, because this strip already holds a text button and
           the sidebar's floor is 200px. -->
      <TooltipButton
        :label="allExpanded ? 'Collapse all' : 'Expand all'"
        :icon="allExpanded ? ChevronsDownUp : ChevronsUpDown"
        :disabled="!hasBranches"
        testid="toggle-sections"
        @click="toggleAll"
      />
      <TooltipButton
        label="Import graph…"
        :icon="Network"
        @click="showImportGraph = true"
      />
      <TooltipButton label="Reload the model tree." :icon="RefreshCw" @click="refresh" />
    </PanelHeader>

    <TreeSearch
      v-model="query"
      label="Filter the model tree"
      placeholder="Filter components"
      testid="model-search"
    />

    <!-- Above the tree, not instead of it: the `role="tree"` element stays
         mounted, so every `data-testid` selector keeps resolving.

         The store set `error` and `isLoading` and nothing read either, so a
         model whose structure could not be read was an empty tree that looked
         finished. -->
    <StateMessage
      v-if="componentTree.error"
      variant="inline"
      tone="danger"
      data-testid="model-tree-error"
    >
      {{ componentTree.error }}
    </StateMessage>
    <StateMessage
      v-else-if="componentTree.isLoading && !nodes.length"
      variant="inline"
      loading
      data-testid="model-tree-loading"
    >
      Reading the model's structure…
    </StateMessage>
    <StateMessage v-else-if="isEmpty" variant="inline" :icon="SearchX">
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
      class="@container min-h-0 flex-1"
      @select="(node, event) => open(node as ModelTreeNode, event)"
    >
      <template #trailing="{ item }">
        <!-- A section row opens *one* file, not the section across the model:
             `component_tree` gives it the first file in import order that
             defines any entry of it, and its children each carry their own. So
             "Techs" on a model with two techs files reads as a claim about the
             model and is a label for a file — which is what this says.

             `aria-hidden`, and a `title` rather than an `InfoTip`, for one
             reason: a tree row's accessible name is its contents, so an
             un-hidden badge renames the row from "Techs" to "Techs
             model_config/techs.yaml". Six browser checks across five files
             select group rows by an anchored `^section$` name, and loosening
             all six to accommodate a decorative label would weaken the very
             assertions `tree-search` makes about filtering. The row's name is
             its label; the file is a visual affordance, and the accessible
             answer is `EditorToolbar`'s, which is a real tooltip on a real
             element.

             The width rules are two, because one is not enough. The Tree's own
             label is a bare `truncate` with no floor and flex shrinks every
             item at once, so `shrink-0` — what the template badge beside it
             uses, and fine for a template name — lets a path eat the label
             instead: at the sidebar's 126px minimum "Techs" measured 17px of
             the 34px it needs. Weighting the shrink fixes the wide half of the
             range and no more; it still left the label 0.1px short at 126px,
             which is enough for the browser to ellipsize "Data tables" anyway.
             So the badge also goes away below 200px, where it is a ~13px stub
             of a path that says nothing and costs nothing to drop. A container
             query rather than a media query: what it depends on is the
             sidebar's width, which the user drags.

             design-check: allow native-title — the unclipped form of the
             `shortenPath` elision beside it. -->
        <span
          v-if="!(item as ModelTreeNode).entryName && (item as ModelTreeNode).file"
          aria-hidden="true"
          :title="(item as ModelTreeNode).file"
          class="ml-auto hidden max-w-1/2 shrink-[100] truncate text-2xs text-text-muted @[200px]:block"
        >
          {{ shortenPath((item as ModelTreeNode).file, 2) }}
        </span>
        <InfoTip
          v-else-if="(item as ModelTreeNode).template"
          :label="`From template ${(item as ModelTreeNode).template}`"
        >
          <Badge variant="outline" :class="cn('ml-auto', NEUTRAL_BADGE)">
            {{ (item as ModelTreeNode).template }}
          </Badge>
        </InfoTip>
        <span
          v-else-if="(item as ModelTreeNode).settingCount"
          class="ml-auto shrink-0 text-2xs tabular-nums text-text-muted"
        >
          {{ (item as ModelTreeNode).settingCount }}
        </span>

        <!-- A math file that is registered and never enabled is read by nobody
             and warned about by nothing: Calliope's view is that you did not ask
             for it. Saying so in the tree is the only place a user finds out
             before wondering why their constraint changed no numbers. -->
        <InfoTip
          v-else-if="mathNote(item as ModelTreeNode)"
          :label="mathNote(item as ModelTreeNode)!.label"
        >
          <Badge
            variant="outline"
            :class="
              cn(
                'ml-auto',
                mathNote(item as ModelTreeNode)!.tone === 'warning'
                  ? WARNING_BADGE
                  : NEUTRAL_BADGE,
              )
            "
          >
            {{ mathNote(item as ModelTreeNode)!.text }}
          </Badge>
        </InfoTip>
      </template>
    </Tree>

    <ImportGraphDialog
      v-if="tabs.versionId"
      v-model:visible="showImportGraph"
      :versionId="tabs.versionId"
    />
  </div>
</template>
