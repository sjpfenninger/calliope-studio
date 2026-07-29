<script setup lang="ts">
/**
 * The totals, as one figure of the results view.
 *
 * Its frame is fetched by the pane above and passed in — see `MapFigure` for why
 * none of the three figures owns a request.
 */
import { computed, inject } from "vue";

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
import { SUM_LABELS, keepOne } from "@/lib/chartControls";
import { exportFrames, hasData } from "@/lib/frameExport";
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
function chooseSum(next: unknown, current: SumBy, variable: string | null): SumBy {
  const value = keepOne(next as SumBy, current);
  return store.sumLock(variable, value) ? current : value;
}
</script>

<template>
  <!-- design-check: allow native-title — `FigurePanel`'s `title` is a prop. -->
  <FigurePanel
    figure="static"
    title="Totals"
    label="the totals chart"
    testid="collapse-static"
  >
    <template #controls>
      <Select v-model="store.variableStatic">
        <SelectTrigger size="sm" class="w-36" data-testid="static-variable">
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
            (store.staticSumBy = chooseSum(
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
            :class="
              store.sumLock(store.variableStatic, option) && 'cursor-default opacity-50'
            "
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
    />
  </FigurePanel>
</template>
