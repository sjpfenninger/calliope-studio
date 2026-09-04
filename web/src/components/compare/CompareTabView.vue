<script setup lang="ts">
/**
 * Two versions of the model, read two ways.
 *
 * **Files** is structure — which files each side has and how their text
 * differs. **Model** is meaning — what Calliope makes of each, compared
 * parameter by parameter. They answer different questions and neither subsumes
 * the other: a changed line in a template moves values on forty technologies,
 * and a scenario changes everything while changing no file at all.
 *
 * The sides are the tab's identity, so changing one is a new tab id. It must
 * not read as one, though — somebody picked a scenario in a header, they did
 * not open something — so `tabs.replaceCompare` rebuilds the entry in place,
 * keeping its position in the bar.
 */
import { computed, onMounted, watch } from "vue";

import PanelHeader from "@/components/app/PanelHeader.vue";
import Segmented from "@/components/app/Segmented.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import CompareFilesView from "@/components/compare/CompareFilesView.vue";
import CompareModelView from "@/components/compare/CompareModelView.vue";
import ScenarioPicker from "@/components/compare/ScenarioPicker.vue";
import { Badge } from "@/components/ui/badge";
import { ArrowLeftRight, RefreshCw } from "@lucide/vue";
import { describeRef, withScenario, type CompareRef } from "@/lib/compareRef";
import { IDENTIFIER, NEUTRAL_BADGE, WARNING_BADGE } from "@/lib/formClasses";
import { useCompareStore } from "@/stores/compare";
import { useRunsStore } from "@/stores/runs";
import { useTabsStore, type CompareSubView, type CompareTab } from "@/stores/tabs";

const props = defineProps<{ tab: CompareTab }>();

const tabs = useTabsStore();
const compare = useCompareStore();
const runs = useRunsStore();

const VIEWS: Array<{ id: CompareSubView; label: string }> = [
  { id: "model", label: "Model" },
  { id: "files", label: "Files" },
];

const segments = computed(() =>
  VIEWS.map((view) => ({
    value: view.id,
    label: view.label,
    testid: `compare-subtab-${view.id}`,
  })),
);

const state = computed(() => compare.stateOf(props.tab.a, props.tab.b));
const sides = computed(() => state.value.files ?? state.value.model);

/** What each side is called, before and after the server has answered. */
function labelOf(ref: CompareRef, which: "a" | "b"): string {
  const described = sides.value?.[which];
  return describeRef(ref, described?.kind === "run" ? described.label : undefined);
}

function sideOf(which: "a" | "b") {
  return sides.value?.[which] ?? null;
}

/**
 * Fetches whichever half is not already known.
 *
 * The pane is `v-if`, so this runs on every return to the tab; unguarded it
 * refetched both halves each time — the model half being a Calliope resolve
 * in a subprocess — and the pane flashed back to "Comparing…" for a diff it
 * had already shown. The store keeps the answer precisely so that it is
 * there to come back to.
 */
function load() {
  const versionId = tabs.versionId;
  if (!versionId) return;
  const known = state.value;
  if (!known.files && !known.loadingFiles) {
    void compare.loadFiles(versionId, props.tab.a, props.tab.b);
  }
  if (props.tab.seenViews.includes("model") && !known.model && !known.loadingModel) {
    void compare.loadModel(versionId, props.tab.a, props.tab.b);
  }
}

function setScenario(which: "a" | "b", scenario: string | null) {
  const a = which === "a" ? withScenario(props.tab.a, scenario) : props.tab.a;
  const b = which === "b" ? withScenario(props.tab.b, scenario) : props.tab.b;
  tabs.replaceCompare(props.tab.id, a, b);
}

function swap() {
  tabs.replaceCompare(props.tab.id, props.tab.b, props.tab.a);
}

onMounted(() => {
  // The run list may never have been looked at, and the scenario picker reads
  // its catalogue — the same arrangement `RunTabView` makes for a cold load.
  if (tabs.versionId) void runs.load(tabs.versionId);
  load();
});

// The sides change under this component when a scenario is picked, because the
// entry is rebuilt in place rather than remounted.
watch(() => [props.tab.a, props.tab.b], load);

// Fetched when first looked at: it can mean resolving a model in a
// subprocess, which is not worth doing for somebody who came for the YAML.
// Not `immediate`: the mount's own `load()` covers the first view, and the
// two together used to issue the same resolve twice.
watch(
  () => props.tab.subView,
  (view) => {
    if (view !== "model" || !tabs.versionId) return;
    if (!state.value.model && !state.value.loadingModel) {
      void compare.loadModel(tabs.versionId, props.tab.a, props.tab.b);
    }
  },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="compare-tab">
    <PanelHeader data-testid="compare-subtabs" size="md" tone="surface">
      <Segmented
        :model-value="tab.subView"
        :items="segments"
        mode="nav"
        seam="none"
        size="fill"
        @update:model-value="$event && tabs.setCompareSubView(tab.id, $event)"
      />

      <div class="flex-1" />

      <div class="flex items-center gap-1.5">
        <template v-for="which in (['a', 'b'] as const)" :key="which">
          <span v-if="which === 'b'" class="text-sm text-text-muted">→</span>

          <ScenarioPicker
            v-if="tab[which].kind === 'workspace'"
            :scenario="tab[which].kind === 'workspace' ? tab[which].scenario : null"
            :testid="`compare-scenario-${which}`"
            :label="`Scenario for the ${which === 'a' ? 'left' : 'right'} side`"
            @update:scenario="setScenario(which, $event)"
          />
          <span v-else :class="IDENTIFIER" :data-testid="`compare-side-${which}`">
            {{ labelOf(tab[which], which) }}
          </span>

          <Badge
            v-if="sideOf(which)?.scenario && tab[which].kind === 'run'"
            variant="outline"
            :class="NEUTRAL_BADGE"
          >
            {{ sideOf(which)?.scenario }}
          </Badge>
          <!-- A run that could not freeze everything it referred to solved the
               live folder instead, so what it shows is not provably what ran. -->
          <Badge
            v-if="sideOf(which)?.snapshot_complete === false"
            variant="outline"
            :class="WARNING_BADGE"
          >
            partial snapshot
          </Badge>
          <Badge
            v-if="sideOf(which) && !sideOf(which)!.scenario_known"
            variant="outline"
            :class="WARNING_BADGE"
            :data-testid="`compare-unknown-scenario-${which}`"
          >
            unknown scenario
          </Badge>
        </template>

        <TooltipButton
          label="Swap the two sides"
          :icon="ArrowLeftRight"
          testid="compare-swap"
          @click="swap"
        />
        <TooltipButton
          label="Compare again, reading both sides afresh"
          :icon="RefreshCw"
          testid="compare-refresh"
          @click="tabs.versionId && compare.refresh(tabs.versionId, tab.a, tab.b)"
        />
      </div>
    </PanelHeader>

    <div class="relative min-h-0 flex-1">
      <CompareModelView
        v-if="tab.seenViews.includes('model')"
        v-show="tab.subView === 'model'"
        :payload="state.model"
        :loading="state.loadingModel"
        :error="state.modelError"
        :gave-up="state.gaveUp"
        class="absolute inset-0"
      />
      <CompareFilesView
        v-if="tab.seenViews.includes('files') && tabs.versionId"
        v-show="tab.subView === 'files'"
        :version-id="tabs.versionId"
        :a="tab.a"
        :b="tab.b"
        :payload="state.files"
        :loading="state.loadingFiles"
        :error="state.filesError"
        :selected-path="tab.selectedPath"
        class="absolute inset-0 flex"
        @select="tabs.setCompareSelection(tab.id, $event)"
      />
    </div>
  </div>
</template>
