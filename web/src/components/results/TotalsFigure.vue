<script setup lang="ts">
/**
 * The totals, as one figure of the results view.
 *
 * Its frame is fetched by the pane above and passed in — see `MapFigure` for why
 * none of the three figures owns a request.
 */
import { computed, inject, onBeforeUnmount } from "vue";

import { Download } from "@lucide/vue";

import FigurePanel from "./FigurePanel.vue";
import InfoTip from "@/components/app/InfoTip.vue";
import ResultChart from "@/components/results/ResultChart.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ResultFrame } from "@/api/results";
import { SUM_LABELS, chooseSum } from "@/lib/chartControls";
import { exportFrames, hasData } from "@/lib/frameExport";
import { FIELD_WIDTH, SOFT_DISABLED } from "@/lib/formClasses";
import { indexColorsFor } from "@/lib/seriesColors";
import { useRoundingStore } from "@/stores/rounding";
import type { DisplayUnit } from "@/lib/units";
import { RUN_SELECTION, SUM_OPTIONS, type SumBy } from "@/stores/runSelection";

const props = defineProps<{
  frame: ResultFrame | null;
  loading: boolean;
  error: string | null;
  /** What `frame`'s values are already scaled to, for the axis and the export. */
  unit: DisplayUnit | null;
}>();

const store = inject(RUN_SELECTION)!;
// Per model rather than per handle — see `TimeseriesFigure`.
const rounding = useRoundingStore();

const variables = computed(() => store.catalog?.variables.static ?? []);

const indexColors = computed(() =>
  indexColorsFor(props.frame, store.effectiveStaticSum, store.catalog?.colors ?? null),
);

/** See `TimeseriesFigure` — the locked options are clickable so they can explain. */
/** Bound to this figure's store, so the template keeps its two-argument call. */
function chooseSumFor(next: unknown, current: SumBy, variable: string | null): SumBy {
  return chooseSum(next, current, (value) => Boolean(store.sumLock(variable, value)));
}

/**
 * Hands the bar under the pointer to the map, when a bar is a node.
 *
 * Decided here on the frame's own `indexName`, not on the sum-by: the chart
 * knows nothing about Calliope, and which dimension lands on the axis is the
 * server's choice — `choose_index` takes the largest one left, so summing the
 * techs away puts nodes on the axis only when there are more of them than
 * carriers. Anything else on the axis clears the map rather than leaving a
 * stale node lit.
 */
function onHoverIndex(value: string | null) {
  store.hoveredNode = value !== null && props.frame?.indexName === "nodes" ? value : null;
}

// A layout without this figure must not keep the map pointing at a bar that is
// no longer on screen.
onBeforeUnmount(() => {
  store.hoveredNode = null;
});
</script>

<template>
  <FigurePanel
    :busy="props.loading"
    figure="static"
    title="Totals"
    label="the totals chart"
    testid="collapse-static"
  >
    <template #controls>
      <Select v-model="store.variableStatic">
        <SelectTrigger size="sm" :class="FIELD_WIDTH.short" data-testid="static-variable">
          <SelectValue placeholder="Variable" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="name in variables" :key="name" :value="name">
            {{ name }}
          </SelectItem>
        </SelectContent>
      </Select>

      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        data-testid="static-sum-by"
        :model-value="store.effectiveStaticSum"
        @update:model-value="
          (value) =>
            (store.staticSumBy = chooseSumFor(
              value,
              store.staticSumBy,
              store.variableStatic,
            ))
        "
      >
        <InfoTip
          v-for="option in SUM_OPTIONS"
          :key="option"
          :label="store.sumLock(store.variableStatic, option)"
        >
          <ToggleGroupItem
            :value="option"
            :aria-disabled="Boolean(store.sumLock(store.variableStatic, option))"
            :class="store.sumLock(store.variableStatic, option) && SOFT_DISABLED"
          >
            {{ SUM_LABELS[option] }}
          </ToggleGroupItem>
        </InfoTip>
      </ToggleGroup>

      <TooltipButton
        label="Export this chart's data as CSV"
        :icon="Download"
        testid="export-static"
        :disabled="!hasData(props.frame)"
        @click="
          exportFrames(
            [{ frame: props.frame, unit: props.unit }],
            store.variableStatic ?? 'totals',
            store.catalog?.name,
            store.techLabels,
            rounding.exportPrecision,
          )
        "
      />
    </template>

    <ResultChart
      name="static"
      :frame="props.frame"
      :index-colors="indexColors"
      kind="bar"
      :loading="props.loading"
      :error="props.error"
      :labels="store.techLabels"
      :unit="props.unit"
      :precision="rounding.precision"
      height="100%"
      class="min-h-0 flex-1"
      @hover-index="onHoverIndex"
    />
  </FigurePanel>
</template>
