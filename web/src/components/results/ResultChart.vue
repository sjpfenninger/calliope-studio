<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import * as echarts from "echarts";
import type { ResultFrame } from "../../api/results";
import {
  GRID_LEFT,
  GRID_RIGHT,
  LEGEND_H,
  ZOOM_H,
  gridBottom,
  gridTop,
  zoomBottom,
} from "../../charts/layout";
import { NO_UNIT, type DisplayUnit } from "../../lib/units";
import { ensureTheme } from "../../charts/theme";
import { resolvedColor } from "../../lib/cssColor";
import { indexToLabel, normaliseIndexValue } from "../../lib/frameIndex";
import { formatValue } from "../../lib/precision";
import StateMessage from "../app/StateMessage.vue";
import { seriesLabel } from "../../lib/seriesLabel";
import { useUiStore } from "../../stores/ui";

const ui = useUiStore();

const props = withDefaults(
  defineProps<{
    frame: ResultFrame | null;
    kind: "bar" | "line" | "area";
    loading?: boolean;
    error?: string | null;
    height?: string;
    /** Display text per technology, for those whose name is not what to show. */
    labels?: Record<string, string>;
    /**
     * Colours for the index values, when the index is what carries identity.
     *
     * Summing a dimension away moves the one that is left onto the axis: ask the
     * totals chart to sum the nodes and every *bar* is a technology, while the
     * series are whatever remains. Colour was only ever read off the series, so
     * the bars came out in one flat palette colour — a chart of eight
     * technologies with nothing to tell them apart, and the same technology a
     * different colour from the map and every other chart beside it.
     *
     * Supplied by the caller rather than inferred, because which dimension owns
     * colour is a question about the model, and this component deliberately knows
     * nothing about Calliope.
     */
    indexColors?: Record<string, string> | null;
    /**
     * What the values are measured in, already applied to `frame`.
     *
     * Only the label reaches this component — the scaling happened in
     * `useResultFrame`, so a chart never multiplies anything. The factor is
     * still needed, but only to tell one render from another: see `render`.
     */
    unit?: DisplayUnit | null;
    /**
     * Significant figures to show, or null for the long-standing default.
     *
     * A prop for the same reason `unit` is one: which digits a reader wants is a
     * setting about the run view, and this component knows nothing about it.
     */
    precision?: number | null;
  }>(),
  { labels: () => ({}), indexColors: null, unit: null, precision: null },
);

const unit = computed(() => props.unit ?? NO_UNIT);

function nameOf(frame: ResultFrame, series: ResultFrame["series"][number]) {
  return seriesLabel(series, frame.seriesDims, props.labels);
}

const container = ref<HTMLDivElement | null>(null);
const chart = shallowRef<echarts.ECharts | null>(null);
let observer: ResizeObserver | null = null;

/**
 * Above this many points a series is drawn through ECharts' bulk renderer,
 * which skips per-point styling. Below it, the ordinary path gives nicer
 * hovering. 8760 hourly values across a handful of technologies is exactly the
 * region where this matters.
 */
const LARGE_SERIES_THRESHOLD = 2000;

/** The hairline between stacked segments that share one colour. */
function separator(): string {
  return resolvedColor("--cg-surface", "#ffffff");
}

/**
 * Whether the index is real time, and so deserves a time axis.
 *
 * The Arrow column's declared type rather than its name, which is the same
 * answer arriving by a better route: a duration curve's `period` index and a
 * category axis are both plainly not timestamps, and nothing has to remember
 * that the time dimension is spelled `timesteps`.
 */
function isTimeIndex(frame: ResultFrame): boolean {
  return frame.indexIsTime;
}

function axisValues(frame: ResultFrame): (string | number)[] {
  // What Arrow hands back — a Date, a BigInt, a string or a number — is settled
  // by `normaliseIndexValue`, which the CSV export shares, so a timestep cannot
  // be one thing on the axis and another in the file. Only the presentation is
  // this component's: a time axis wants epoch milliseconds.
  return frame.index.map((value) => {
    const index = normaliseIndexValue(value);
    if (index instanceof Date) return index.getTime();
    // The index carries identity, so it gets the same display names the legend
    // gives it — a link reads `A → B` on the axis exactly as it does everywhere
    // else, rather than reverting to its generated `a_to_b` technology name.
    //
    // Through `indexToLabel`, whose docstring asks for exactly that and whose
    // other two callers are the CSV writer and the table. This used to be a
    // second, hand-rolled copy guarded on `indexColors` instead of on the
    // dimension — and the two guards disagree, because `indexColorsFor` also
    // returns null when nothing is summed. So on a techs-indexed frame with no
    // sum-by the axis read `a_to_b` while the table and the exported CSV of the
    // *same* frame read `A → B`.
    const text = String(index);
    const label = indexToLabel(text, frame.indexName, props.labels);
    // The original value when there was nothing to substitute, so a numeric
    // index stays a number and the axis keeps inferring what it always did.
    return label === text ? index : label;
  });
}

/**
 * The narrowest gap between consecutive index values, in milliseconds.
 *
 * ECharts 5 padded a time axis out to round units; 6 fits it to the data's own
 * extent. On a resampled frame that is a real difference: two Daily points are
 * one day apart, so the whole axis is 24 hours wide and 6 ticks it every four
 * *hours* — labelling times that no bucket in the data covers, under bars that
 * are each a day wide. `minInterval` is a floor rather than a step, so handing
 * it the spacing the data actually has stops the subdivision without disturbing
 * an unresampled frame, where the interval ECharts already chooses is coarser
 * than one timestep anyway.
 */
function timeStep(values: unknown[]): number {
  let smallest = Number.POSITIVE_INFINITY;
  for (let position = 1; position < values.length; position += 1) {
    const gap = Number(values[position]) - Number(values[position - 1]);
    if (gap > 0 && gap < smallest) smallest = gap;
  }
  return Number.isFinite(smallest) ? smallest : 0;
}

function buildOption(frame: ResultFrame): echarts.EChartsOption {
  const axis = axisValues(frame);
  const onTime = isTimeIndex(frame);
  const stacked = props.kind !== "line";
  const totalPoints = frame.index.length * Math.max(frame.series.length, 1);
  const byIndex = props.indexColors;
  // Colour means the axis now, so a one-entry legend could only mislead: its
  // swatch would be a single colour standing beside bars of several. The series
  // name still reaches the reader through the tooltip.
  const withLegend = !byIndex;

  const toPoint = (value: number, position: number) => {
    const y = Number.isNaN(value) ? null : value;
    // A time axis needs explicit x values; a category axis takes the series in
    // index order.
    if (onTime) return [axis[position], y];
    if (!byIndex) return y;
    // Looked up on the raw index value, not on `axis`, which may have been
    // substituted for a display name.
    const color = byIndex[String(frame.index[position])];
    return color ? { value: y, itemStyle: { color } } : y;
  };

  return {
    animation: totalPoints < LARGE_SERIES_THRESHOLD,
    // See charts/layout.ts: the bottom is derived from the slider and legend
    // rather than being a fourth number that has to agree with them.
    grid: {
      left: GRID_LEFT,
      right: GRID_RIGHT,
      top: gridTop(Boolean(unit.value.label)),
      bottom: gridBottom(withLegend),
      containLabel: true,
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: stacked ? "shadow" : "line" },
      // A model can define dozens of technologies; largest first makes the
      // tooltip readable when they are all in it.
      order: "valueDesc",
      confine: true,
      // Unconditional, where it used to appear only when a unit was configured:
      // without it the tooltip printed the raw float, so hovering a stack gave
      // eight numbers of seventeen digits each. The unit is appended when there
      // is one, which is the one thing the axis label cannot do — a reader
      // hovering a stack has no unit anywhere near them.
      valueFormatter: (value: unknown) => {
        if (value == null) return "—";
        const text = formatValue(value as number, props.precision);
        if (!text) return "—";
        return unit.value.label ? `${text} ${unit.value.label}` : text;
      },
    },
    legend: withLegend
      ? { type: "scroll", bottom: 0, height: LEGEND_H }
      : { show: false },
    xAxis: onTime
      ? { type: "time", minInterval: timeStep(axis), axisLabel: { hideOverlap: true } }
      : {
          type: "category",
          data: axis,
          boundaryGap: props.kind === "bar",
          axisLabel: { hideOverlap: true },
        },
    // Still no title — the variable is the panel header's, because a chart's
    // title belongs in the DOM on the app's type scale rather than painted into
    // the canvas at ECharts' own font settings. The *unit* is the exception: it
    // qualifies the tick numbers, so it has to sit where they are. Above the
    // axis rather than rotated beside it, which costs 16px once instead of
    // eating into the plot width on every chart.
    yAxis: {
      type: "value",
      // Always present, `null` when there is nothing to apply — never omitted.
      // A merged option never *removes* a key, so an omitted formatter would
      // stay installed after the field was cleared, and the ticks would keep
      // showing a precision the user had just taken away. ECharts falls back to
      // its own label for anything that is neither a function nor a template
      // string, so `null` is how a formatter is withdrawn.
      axisLabel: {
        // Cast because the types say `string | function | undefined`, and
        // `undefined` is not the same thing: a merged option ignores it, where
        // `null` reaches ECharts and fails its `isString`/`isFunction` checks,
        // which is precisely the fall-through to the built-in label.
        formatter: (props.precision === null
          ? null
          : (value: number) => formatValue(value, props.precision)) as
          | ((value: number) => string)
          | undefined,
      },
      ...(unit.value.label
        ? { name: unit.value.label, nameLocation: "end", nameGap: 8 }
        : {}),
    },
    dataZoom: [
      { type: "inside", throttle: 50 },
      { type: "slider", height: ZOOM_H, bottom: zoomBottom(withLegend) },
    ],
    series: frame.series.map((series) => ({
      // `tooltip.trigger: "axis"` renders this too, so the short name reaches the
      // tooltip with no formatter.
      name: nameOf(frame, series),
      type: props.kind === "bar" ? "bar" : "line",
      stack: stacked ? "total" : undefined,
      areaStyle: props.kind === "area" ? {} : undefined,
      symbol: "none",
      itemStyle: {
        ...(series.color ? { color: series.color } : {}),
        // Every segment of a bar takes its *category's* colour when colour maps
        // to the axis, so without a hairline between them a stack of three
        // carriers would read as one solid bar.
        ...(props.indexColors && frame.series.length > 1
          ? { borderColor: separator(), borderWidth: 1 }
          : {}),
      },
      large: series.values.length > LARGE_SERIES_THRESHOLD,
      largeThreshold: LARGE_SERIES_THRESHOLD,
      progressive: 4000,
      progressiveThreshold: LARGE_SERIES_THRESHOLD,
      data: Array.from(series.values, toPoint),
    })),
  };
}

/** The shape of the last option applied, to spot changes merging cannot absorb. */
let lastShape = "";

function render() {
  if (!chart.value) return;
  if (!props.frame || props.frame.series.length === 0) {
    chart.value.clear();
    lastShape = "";
    return;
  }

  // Merging is what makes an arriving batch extend the chart rather than
  // rebuild it, and it is safe *within* one stream because the schema is fixed
  // for its whole duration: only rows accumulate.
  //
  // Two changes it cannot absorb, and both happen constantly:
  //   - the axis switching between time and category, which Duration does;
  //   - the set of series changing, because a merged option never *removes* a
  //     series. Deselecting a technology would otherwise leave it on the chart.
  const shape = [
    isTimeIndex(props.frame),
    props.kind,
    props.frame.variable,
    // Whether colour maps to the axis, because that decides the legend and with
    // it the grid: a merge never puts a hidden legend back, so a chart that had
    // one and then did not would keep the gap where it used to be.
    Boolean(props.indexColors),
    // Keyed on the rendered names rather than the raw ones: just as
    // discriminating, and it forces a replace when the labels change under an
    // unchanged set of keys, where merging would draw the new names beside the old.
    props.frame.series.map((series) => nameOf(props.frame!, series)).join("\u001f"),
    // The label, because it changes the grid — a merge never takes an axis name
    // away, so a chart that had one would keep the 16px after it went. The
    // factor, because a rescale changes every value while leaving the series
    // names identical, and a merge keyed only on names would keep drawing the
    // old numbers. That failure looks exactly like the setting doing nothing.
    unit.value.label,
    unit.value.factor,
  ].join("|");
  const replace = shape !== lastShape;
  lastShape = shape;

  chart.value.setOption(buildOption(props.frame), {
    notMerge: replace,
    lazyUpdate: true,
  });
}

function mount() {
  if (!container.value) return;
  chart.value = echarts.init(container.value, ensureTheme(ui.revision), {
    renderer: "canvas",
  });
  render();
}

onMounted(() => {
  if (!container.value) return;
  mount();
  observer = new ResizeObserver(() => chart.value?.resize());
  observer.observe(container.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  chart.value?.dispose();
  chart.value = null;
});

watch(() => props.frame, render);
watch(() => props.kind, render);
watch(unit, render);
// Deliberately *not* in `lastShape`: a precision change swaps two formatter
// functions and nothing else, which a merge absorbs. Forcing a replace here
// would throw away the reader's dataZoom on every keystroke in the field.
watch(() => props.precision, render);

// A theme is bound at `echarts.init` and cannot be swapped by `setOption`, so a
// theme change means disposing and rebuilding. `lastShape` has to be cleared
// with it: the next render would otherwise merge into a brand-new, empty
// instance and draw nothing.
watch(
  () => ui.revision,
  () => {
    chart.value?.dispose();
    chart.value = null;
    lastShape = "";
    mount();
  },
);
/**
 * A first load shows `StateMessage`; a refetch shows nothing here at all.
 *
 * ECharts' own `showLoading` spinner was a fourth loading treatment, drawn in
 * the canvas and so unable to look like the other three. On a refetch the old
 * data stays on screen and the panel header's `ProgressHairline` carries the
 * fact that something is happening, which is both calmer and more informative
 * than blanking a chart on every filter change.
 */
const firstLoad = computed(() => props.loading && !props.frame);
</script>

<template>
  <div class="relative w-full" :style="{ height: height ?? '100%' }">
    <StateMessage
      v-if="error"
      variant="fill"
      tone="danger"
      class="absolute inset-0 bg-surface"
    >{{ error }}</StateMessage>
    <StateMessage
      v-else-if="firstLoad"
      variant="fill"
      loading
      class="pointer-events-none absolute inset-0"
    >Reading results…</StateMessage>
    <StateMessage
      v-else-if="frame && frame.series.length === 0"
      variant="fill"
      class="pointer-events-none absolute inset-0"
    >No data for this selection.</StateMessage>
    <div ref="container" class="absolute inset-0" />
  </div>
</template>
