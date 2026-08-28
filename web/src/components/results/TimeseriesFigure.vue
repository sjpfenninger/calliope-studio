<script setup lang="ts">
/**
 * The time series, as one figure of the results view.
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
import { RESOLUTION_LABELS, SUM_LABELS, chooseSum, keepOne } from "@/lib/chartControls";
import { exportFrames, hasData } from "@/lib/frameExport";
import type { DisplayUnit } from "@/lib/units";
import { indexColorsFor } from "@/lib/seriesColors";
import { useRoundingStore } from "@/stores/rounding";
import {
  RESOLUTIONS,
  RUN_SELECTION,
  SUM_OPTIONS,
  type PlotType,
  type SumBy,
} from "@/stores/runSelection";

const props = defineProps<{
  frame: ResultFrame | null;
  loading: boolean;
  error: string | null;
  /** What `frame`'s values are already scaled to, for the axis and the export. */
  unit: DisplayUnit | null;
}>();

const store = inject(RUN_SELECTION)!;
// A per-model setting rather than a per-handle one, so it is read here rather
// than threaded down from the pane the way `frame` and `unit` are.
const rounding = useRoundingStore();

const PLOT_TYPES: PlotType[] = ["Bar", "Line", "Area", "Duration"];
const resolutions = Object.keys(RESOLUTIONS);

const variables = computed(() => store.catalog?.variables.timeseries ?? []);

const indexColors = computed(() =>
  indexColorsFor(props.frame, store.effectiveSumBy, store.catalog?.colors ?? null),
);

/**
 * `keepOne` for the sum-by toggles, refusing a locked option.
 *
 * The locked items carry `aria-disabled` rather than `disabled`, because a
 * natively disabled button receives no pointer events and so could never open
 * the tooltip that explains why it is locked — the same trade `PanelDisclosure`
 * makes. The click therefore still arrives, and this is what ignores it.
 */
/** Bound to this figure's store, so the template keeps its two-argument call. */
function chooseSumFor(next: unknown, current: SumBy, variable: string | null): SumBy {
  return chooseSum(next, current, (value) => Boolean(store.sumLock(variable, value)));
}
</script>

<template>
  <FigurePanel
    :busy="props.loading"
    figure="timeseries"
    title="Time series"
    label="the time series"
    testid="collapse-timeseries"
  >
    <template #controls>
      <Select v-model="store.variableTimeseries">
        <SelectTrigger size="sm" class="w-36" data-testid="timeseries-variable">
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
        data-testid="plot-type"
        :model-value="store.plotType"
        @update:model-value="(value) => (store.plotType = keepOne(value, store.plotType))"
      >
        <ToggleGroupItem v-for="type in PLOT_TYPES" :key="type" :value="type">
          {{ type }}
        </ToggleGroupItem>
      </ToggleGroup>

      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        data-testid="resolution"
        :model-value="store.resolution"
        @update:model-value="
          (value) => (store.resolution = keepOne(value, store.resolution))
        "
      >
        <ToggleGroupItem v-for="name in resolutions" :key="name" :value="name">
          {{ RESOLUTION_LABELS[name] ?? name }}
        </ToggleGroupItem>
      </ToggleGroup>

      <!-- Every option, always: one the variable cannot honour is locked and
           says why, never taken away. See SUM_OPTIONS. -->
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        data-testid="sum-by"
        :model-value="store.effectiveSumBy"
        @update:model-value="
          (value) =>
            (store.sumBy = chooseSumFor(value, store.sumBy, store.variableTimeseries))
        "
      >
        <InfoTip
          v-for="option in SUM_OPTIONS"
          :key="option"
          :label="store.sumLock(store.variableTimeseries, option)"
        >
          <ToggleGroupItem
            :value="option"
            :aria-disabled="Boolean(store.sumLock(store.variableTimeseries, option))"
            :class="
              store.sumLock(store.variableTimeseries, option) &&
              'cursor-default opacity-50'
            "
          >
            {{ SUM_LABELS[option] }}
          </ToggleGroupItem>
        </InfoTip>
      </ToggleGroup>

      <!-- Inline, with no spacer before it. A `flex-1` would right-align it, and
           in a wrapping header that means it takes a second row of its own —
           making this title bar half as tall again as the two beside it, which
           is what RESOLUTION_LABELS exists to prevent and what a collapsed
           figure is measured by. -->
      <TooltipButton
        label="Export this chart's data as CSV"
        :icon="Download"
        testid="export-timeseries"
        :disabled="!hasData(props.frame)"
        @click="
          exportFrames(
            [{ frame: props.frame, unit: props.unit }],
            store.variableTimeseries ?? 'timeseries',
            store.catalog?.name,
            store.techLabels,
            rounding.exportPrecision,
          )
        "
      />
    </template>

    <ResultChart
      name="timeseries"
      :frame="props.frame"
      :index-colors="indexColors"
      :kind="store.timeseriesKind"
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
