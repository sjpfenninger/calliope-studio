<script setup lang="ts">
/**
 * The time series, as one figure of the results view.
 *
 * Its frame is fetched by the pane above and passed in — see `MapFigure` for why
 * none of the three figures owns a request.
 */
import { computed, inject, ref } from "vue";

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
import {
  type DayBoxOutcome,
  daysFromWindow,
  daysOfExtent,
  windowForFrom,
  windowForTo,
} from "@/lib/dateWindow";
import type { CsvSource } from "@/lib/frameCsv";
import { exportFrames, hasData } from "@/lib/frameExport";
import { FIELD, FIELD_LABEL, FIELD_WIDTH, SOFT_DISABLED } from "@/lib/formClasses";
import { cn } from "@/lib/utils";
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
  /** The overlay's frame and unit, fetched by the pane like the main one. */
  overlayFrame?: ResultFrame | null;
  overlayLoading?: boolean;
  overlayError?: string | null;
  overlayUnit?: DisplayUnit | null;
}>();

const store = inject(RUN_SELECTION)!;
// A per-model setting rather than a per-handle one, so it is read here rather
// than threaded down from the pane the way `frame` and `unit` are.
const rounding = useRoundingStore();

const PLOT_TYPES: PlotType[] = ["Bar", "Line", "Area", "Duration"];
const resolutions = Object.keys(RESOLUTIONS);

const variables = computed(() => store.catalog?.variables.timeseries ?? []);

/** The select's value for "no overlay": a `Select` cannot hold `null`. */
const NONE = "__none__";
const overlayValue = computed(() => store.overlayVariable ?? NONE);
function setOverlay(value: unknown) {
  const next = String(value ?? NONE);
  store.overlayVariable = next === NONE ? null : next;
}

/**
 * Why the overlay is not drawn, or "" when it is.
 *
 * The choice is kept rather than cleared under a duration curve — the query
 * goes null, the line comes back with the time axis — so the control stays
 * usable and only *looks* inactive, with the tooltip saying why.
 */
const overlayIdle = computed(() =>
  store.plotType === "Duration" ? "Not drawn on a duration curve, whose x-axis is rank rather than time." : "",
);

/**
 * What the overlay's tooltip says: why it is idle, or why it failed.
 *
 * An overlay is opt-in, so its failure — a selector its variable does not
 * carry, a unit that will not parse — is reported on its own control and the
 * chart the reader already had stays drawn. Passing it to the chart's `error`
 * blanked the whole canvas for a line nobody had seen yet.
 */
const overlayNote = computed(() => overlayIdle.value || props.overlayError || "");

/**
 * The days the chart is zoomed to, as the boxes show them.
 *
 * Read off the store's window rather than held here, so a drag of the slider
 * — which the chart reports into the same window — shows up in the boxes, and
 * a reset empties them. Typing goes the other way: a window is written and the
 * chart applies it.
 */
const days = computed(() => daysFromWindow(store.zoomWindow));
const dayBounds = computed(() => daysOfExtent(store.timeExtent));

/** A day box is `FIELD` at the width of the selects beside it, not the row's. */
const DAY_BOX = cn(FIELD, FIELD_WIDTH.short);

/** The `to` the reader typed that could not be applied, kept to show as invalid. */
const badTo = ref<string | null>(null);

/**
 * What a box's `change` comes to — decided in `lib/dateWindow`, which is
 * where it is tested. A null outcome is a box mid-edit or emptied on purpose:
 * the window stays where it is, and the box snaps back to the window's day
 * on blur; the reset button is how a window is cleared.
 */
function applyDay(outcome: DayBoxOutcome) {
  badTo.value = null;
  if (outcome === null) return;
  if ("invalid" in outcome) return;
  store.zoomWindow = outcome.window;
}

function setFrom(from: string) {
  applyDay(windowForFrom(from, store.timeExtent));
}

function setTo(to: string) {
  const outcome = windowForTo(to, days.value?.from, store.timeExtent);
  applyDay(outcome);
  if (outcome !== null && "invalid" in outcome) badTo.value = to;
}

/** Puts a box left mid-edit or emptied back to the day the chart shows. */
function resync(event: FocusEvent, day: string | null | undefined) {
  const box = event.target as HTMLInputElement;
  const shown = day ?? "";
  if (box.value !== shown) box.value = shown;
}

/**
 * Why the boxes are idle, or "" when they are not.
 *
 * Idle in the same sense as the overlay select: `aria-disabled` and dimmed,
 * still accepting a day. A window typed under a duration curve reaches the
 * store, where the chart — on a rank axis — ignores it until the time axis
 * comes back and then starts from it, which is the same thing the slider's
 * own window does across that switch.
 */
const daysIdle = computed(() =>
  store.plotType === "Duration" ? "A duration curve has no dates: its x-axis is rank." : "",
);

/**
 * What the CSV holds: the main frame, and the overlay beside it when drawn.
 *
 * Labelled by variable, as the map's channels are: `frameToCsv` prefixes a
 * column only when there are several sources *and* a label, so a lone frame
 * exports exactly as before, while `flow_out` beside `flow_in` — both summed
 * by technology — no longer yields two columns called `ccgt`.
 */
const exportSources = computed<CsvSource[]>(() => [
  { label: props.frame?.variable, frame: props.frame, unit: props.unit },
  ...(hasData(props.overlayFrame ?? null)
    ? [
        {
          label: props.overlayFrame?.variable,
          frame: props.overlayFrame ?? null,
          unit: props.overlayUnit ?? null,
        },
      ]
    : []),
]);

/** The file is named after both variables when both are in it. */
const exportName = computed(() =>
  [store.variableTimeseries, hasData(props.overlayFrame ?? null) ? props.overlayFrame?.variable : null]
    .filter(Boolean)
    .join("-") || "timeseries",
);

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
        <SelectTrigger size="sm" :class="FIELD_WIDTH.short" data-testid="timeseries-variable">
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

      <!-- The window, as days: the same thing the slider under the chart moves,
           so dragging it fills these in and typing here moves it. -->
      <InfoTip :label="daysIdle">
        <span class="flex shrink-0 items-center gap-1" data-testid="date-range">
          <span :class="FIELD_LABEL">from</span>
          <input
            type="date"
            :value="days?.from ?? ''"
            :min="dayBounds?.first"
            :max="dayBounds?.last"
            :class="[DAY_BOX, daysIdle && SOFT_DISABLED]"
            :aria-disabled="Boolean(daysIdle)"
            data-testid="date-from"
            @change="setFrom(($event.target as HTMLInputElement).value)"
            @blur="resync($event, days?.from)"
          />
          <span :class="FIELD_LABEL">to</span>
          <input
            type="date"
            :value="badTo ?? days?.to ?? ''"
            :min="days?.from ?? dayBounds?.first"
            :max="dayBounds?.last"
            :class="[DAY_BOX, daysIdle && SOFT_DISABLED]"
            :aria-disabled="Boolean(daysIdle)"
            :aria-invalid="badTo !== null"
            data-testid="date-to"
            @change="setTo(($event.target as HTMLInputElement).value)"
            @blur="resync($event, badTo ?? days?.to)"
          />
        </span>
      </InfoTip>

      <!-- A second variable as a line on its own axis. Its sum follows the
           toggle below, as far as its dimensions allow. -->
      <InfoTip :label="overlayNote">
        <Select :model-value="overlayValue" @update:model-value="setOverlay">
          <SelectTrigger
            size="sm"
            :class="[FIELD_WIDTH.short, overlayIdle && SOFT_DISABLED]"
            :aria-disabled="Boolean(overlayIdle)"
            :aria-invalid="Boolean(props.overlayError)"
            data-testid="overlay-variable"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="NONE">No overlay</SelectItem>
            <SelectItem v-for="name in variables" :key="name" :value="name">
              {{ name }}
            </SelectItem>
          </SelectContent>
        </Select>
      </InfoTip>

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
            :class="store.sumLock(store.variableTimeseries, option) && SOFT_DISABLED"
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
            exportSources,
            exportName,
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
      :loading="props.loading || Boolean(props.overlayLoading)"
      :error="props.error"
      :labels="store.techLabels"
      :unit="props.unit"
      :overlay-frame="props.overlayFrame ?? null"
      :overlay-unit="props.overlayUnit ?? null"
      :window="store.zoomWindow"
      :precision="rounding.precision"
      @update:window="store.zoomWindow = $event"
      height="100%"
      class="min-h-0 flex-1"
    />
  </FigurePanel>
</template>
