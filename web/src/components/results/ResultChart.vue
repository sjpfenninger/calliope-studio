<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import * as echarts from "echarts";
import type { ResultFrame } from "../../api/results";
import {
  GRID_LEFT,
  GRID_RIGHT,
  GRID_TOP,
  LEGEND_H,
  ZOOM_H,
  gridBottom,
  zoomBottom,
} from "../../charts/layout";
import { ensureTheme } from "../../charts/theme";
import { resolvedColor } from "../../lib/cssColor";
import { normaliseIndexValue } from "../../lib/frameIndex";
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
  }>(),
  { labels: () => ({}), indexColors: null },
);

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
    if (props.indexColors) return props.labels[String(index)] ?? index;
    return index;
  });
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
      top: GRID_TOP,
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
    },
    legend: withLegend
      ? { type: "scroll", bottom: 0, height: LEGEND_H }
      : { show: false },
    xAxis: onTime
      ? { type: "time", axisLabel: { hideOverlap: true } }
      : {
          type: "category",
          data: axis,
          boundaryGap: props.kind === "bar",
          axisLabel: { hideOverlap: true },
        },
    // No `name`: the variable is the panel header's title now. A chart's title
    // belongs in the DOM, on the app's type scale, not painted into the canvas
    // at ECharts' own font settings.
    yAxis: { type: "value" },
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
