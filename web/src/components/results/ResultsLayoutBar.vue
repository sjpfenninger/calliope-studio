<script setup lang="ts">
/**
 * How the three figures are arranged, and what the charts are narrowed to.
 *
 * The layouts are the point — see `lib/resultsLayouts` for why a single stored
 * geometry made switching figures on and off mean re-dragging the boundaries
 * every time.
 *
 * The node narrowing rides along rather than staying in the map's own header,
 * where it used to be: a map folded to its title bar took the notice and the
 * Clear button with it, so the charts stayed narrowed to nodes the user could
 * neither see nor unpick. It is also the one piece of state that survives every
 * layout, which is exactly what a strip above them all is for.
 */
import { computed, inject } from "vue";

import { RotateCcw } from "@lucide/vue";

import PanelHeader from "@/components/app/PanelHeader.vue";
import Segmented from "@/components/app/Segmented.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import { RESULTS_LAYOUTS, type ResultsLayoutId } from "@/lib/resultsLayouts";
import { RUN_SELECTION } from "@/stores/runSelection";
import { useUiStore } from "@/stores/ui";

const props = defineProps<{
  /** The layout on screen, which is not the stored one when there is no map. */
  active: ResultsLayoutId;
}>();

const ui = useUiStore();
const store = inject(RUN_SELECTION)!;

/**
 * The layouts on offer.
 *
 * A map-bearing layout is dropped outright for a model with no geography rather
 * than shown disabled: there is nothing the user can do about it here, and the
 * empty state the map itself shows already says so.
 */
const segments = computed(() =>
  RESULTS_LAYOUTS.filter((layout) => store.hasGeography || !layout.needsMap).map(
    (layout) => ({
      value: layout.id,
      label: layout.label,
      icon: layout.icon,
      testid: `results-layout-${layout.id}`,
    }),
  ),
);
</script>

<template>
  <PanelHeader size="sm" data-testid="results-layout-bar">
    <Segmented
      :model-value="props.active"
      :items="segments"
      mode="value"
      size="sm"
      @update:model-value="$event && ui.setResultsLayout($event)"
    />

    <TooltipButton
      v-if="!ui.resultsLayoutIsDefault"
      label="Put this layout back the way it started"
      :icon="RotateCcw"
      size="sm"
      testid="results-layout-reset"
      @click="ui.resetResultsLayout()"
    />

    <div class="flex-1" />

    <template v-if="store.mapNodes.length">
      <span class="truncate text-2xs text-text-faint">
        Charts narrowed to {{ store.mapNodes.join(", ") }}
      </span>
      <button
        type="button"
        class="rounded-xs px-1 text-2xs text-accent-text hover:bg-hover"
        data-testid="clear-map-nodes"
        @click="store.mapNodes = []"
      >
        Clear
      </button>
    </template>
    <span v-else-if="store.hasGeography" class="shrink-0 text-2xs text-text-faint">
      Click nodes on the map to narrow the charts.
    </span>
  </PanelHeader>
</template>
