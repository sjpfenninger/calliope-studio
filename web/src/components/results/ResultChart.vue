<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import * as echarts from "echarts";
import { RotateCcw } from "@lucide/vue";
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
import TooltipButton from "../app/TooltipButton.vue";
import {
  clipWindow,
  isZoomed,
  windowFromEvent,
  type Extent,
  type ZoomWindow,
} from "../../lib/chartZoom";
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
    /**
     * Registers the ECharts instance at `window.__cgCharts[name]`.
     *
     * The second sanctioned testing seam, after ModelMap's `__cgMap`, and for
     * the same reason: the chart draws to a canvas, so its dataZoom has no
     * element `data-testid` can reach — `dispatchAction` is the only honest way
     * for a script to zoom it, and `getOption` the only way to check the zoom
     * took. Last mounted wins per name, exactly as `__cgMap` behaves.
     */
    name?: string | null;
  }>(),
  { labels: () => ({}), indexColors: null, unit: null, precision: null, name: null },
);

const emit = defineEmits<{
  /**
   * The index value under the axis pointer, or null when there is none.
   *
   * The raw value as text — the same string `indexColors` is keyed on and a map
   * feature is identified by — never the display label, which `axisValues` may
   * have substituted. Follows the axis pointer rather than the painted
   * rectangle: the tooltip is axis-triggered, so its shadow band is what the
   * reader is pointing at, and the highlight has to agree with what the tooltip
   * is talking about. Null on leaving the chart, on the legend or the zoom
   * slider, and whenever the frame changes. A time axis emits nothing: a
   * timestep is not a thing anything else can point at.
   */
  hoverIndex: [value: string | null];
}>();

const unit = computed(() => props.unit ?? NO_UNIT);

/** The last value emitted, because the axis pointer fires on every mousemove. */
let lastHover: string | null = null;

function emitHover(value: string | null) {
  if (value === lastHover) return;
  lastHover = value;
  emit("hoverIndex", value);
}

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

function buildOption(frame: ResultFrame, zoom: ZoomWindow | null): echarts.EChartsOption {
  const axis = axisValues(frame);
  const onTime = isTimeIndex(frame);
  // On both dataZoom components: they share the axis, and two ranges at init
  // would leave the last one applied in charge. A range only ever rides on a
  // replace — see `render`.
  const carried = zoom && onTime ? { startValue: zoom.startValue, endValue: zoom.endValue } : {};
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
      { type: "inside", throttle: 50, ...carried },
      { type: "slider", height: ZOOM_H, bottom: zoomBottom(withLegend), ...carried },
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

/**
 * The time axis last drawn, and the reader's window on it.
 *
 * Caches of what ECharts already holds, like `lastShape`, rather than state of
 * their own: the instance keeps the zoom, but only until the next replace, and
 * these are what let the replace hand it back. Epoch milliseconds, because the
 * `datazoom` event reports percentages of the axis, and a percentage of a frame
 * that is no longer on screen is not a place — a daily resample ends hours
 * before the hourly frame did, and another variable need not share its
 * timesteps at all.
 */
let lastExtent: Extent | null = null;
let zoomWindow: ZoomWindow | null = null;
/** Whether anything is zoomed, on any axis — which is when a reset means something. */
const zoomed = ref(false);

function timeValue(value: unknown): number {
  const index = normaliseIndexValue(value);
  return index instanceof Date ? index.getTime() : Number(index);
}

/** The first and last instant on a time axis, as `axisValues` would draw them. */
function timeExtent(frame: ResultFrame): Extent | null {
  if (!isTimeIndex(frame) || frame.index.length === 0) return null;
  const first = timeValue(frame.index[0]);
  const last = timeValue(frame.index[frame.index.length - 1]);
  return Number.isFinite(first) && Number.isFinite(last) && last > first ? [first, last] : null;
}

function render() {
  if (!chart.value) return;
  // Whatever the pointer was over is gone: a clear or a `notMerge` replace
  // removes the axis pointer without any pointer event, and a frame that
  // changed under a standing pointer may have a different dimension on its
  // axis. The next mousemove re-emits against the new frame.
  emitHover(null);
  if (!props.frame || props.frame.series.length === 0) {
    chart.value.clear();
    lastShape = "";
    // The window is kept: a selection emptied and refilled comes back at the
    // week the reader was looking at. Nothing is drawn, so nothing to reset.
    lastExtent = null;
    zoomed.value = false;
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

  // A replace used to cost the reader their zoom, because a fresh option
  // starts at the whole range — so comparing two variables over one week meant
  // zooming into that week twice. Now the window rides on the replace, and only
  // on the replace: a merge already keeps whatever is set, since ECharts leaves
  // the range alone when the new option names none, and a batch arriving
  // mid-zoom must not put the window back where it was. Only onto a time axis,
  // too: a duration curve's x is rank, not time, so the window is dropped on
  // the way to one and on the way back. A frame that does not reach the window
  // is clamped to its edge by ECharts, which is rare — every variable of one
  // model shares its timesteps — and is what was asked for.
  const onTime = isTimeIndex(props.frame);
  if (!onTime) zoomWindow = null;
  // Measured from the frame as drawn, which mid-stream is the part that has
  // arrived: a zoom made then is read against a short axis, and may sit a
  // little off once the rest lands. Nothing waits on a stream for that.
  lastExtent = onTime ? timeExtent(props.frame) : null;
  // Clipped to the new axis rather than handed over as it was: a window that
  // misses the axis entirely — a monthly frame after a zoom into one day of
  // an hourly one — left ECharts clamped to an edge with the reset button
  // still showing.
  const carried = replace ? clipWindow(zoomWindow, lastExtent) : null;

  chart.value.setOption(buildOption(props.frame, carried), {
    notMerge: replace,
    lazyUpdate: true,
  });
  // No event follows a range set by option, so the button has to be told.
  if (replace) zoomed.value = carried !== null;
}

/** The pixel where the plot area, and so the slider under it, begins. */
function gridLeft(instance: echarts.ECharts): number {
  // `containLabel` widens the gutter to whatever the y-axis labels need, so the
  // slider's left edge is not a constant and the button beside it cannot be
  // placed from one. The grid's rect is the only thing that says where it is,
  // and `getModel` is the only way to it: private in the typings, public on the
  // instance since ECharts 4 — `convertToPixel` places a data point, not the
  // axis's own extent. Guarded so an upstream change misplaces the button by a
  // few pixels rather than throwing inside a render event.
  try {
    const model = (
      instance as unknown as {
        getModel(): {
          getComponent(
            type: string,
          ): { coordinateSystem?: { getRect(): { x: number } } } | undefined;
        };
      }
    ).getModel();
    const x = model.getComponent("grid")?.coordinateSystem?.getRect().x;
    return typeof x === "number" && Number.isFinite(x) ? x : GRID_LEFT + RESET_FALLBACK_GUTTER;
  } catch {
    return GRID_LEFT + RESET_FALLBACK_GUTTER;
  }
}

/** 20px — `TooltipButton`'s `xs` tier, the one size below the 24px rows around it. */
const RESET_H = 20;
/** Clear of the slider's left handle, which is what the button must not cover. */
const RESET_GAP = 4;
/** About the width of a three-digit y label with its margin, when the rect cannot be read. */
const RESET_FALLBACK_GUTTER = 32;
const resetLeft = ref(0);
/** Centred on the 16px slider band, whose bottom moves with the legend. */
const resetBottom = computed(() => zoomBottom(!props.indexColors) + (ZOOM_H - RESET_H) / 2);

function placeReset() {
  if (!chart.value) return;
  resetLeft.value = Math.max(0, gridLeft(chart.value) - RESET_H - RESET_GAP);
}

function resetZoom() {
  // Through the action rather than by touching state: the `datazoom` event it
  // raises is what clears the window and hides the button, exactly as a drag
  // home would.
  chart.value?.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
}

function mount() {
  if (!container.value) return;
  chart.value = echarts.init(container.value, ensureTheme(ui.revision), {
    renderer: "canvas",
  });
  // Registration lives here rather than in `onMounted` so a theme rebuild,
  // which disposes and calls `mount()` again, points the seam at the fresh
  // instance rather than at one that no longer draws.
  if (props.name) {
    const global = window as unknown as { __cgCharts?: Record<string, echarts.ECharts> };
    (global.__cgCharts ??= {})[props.name] = chart.value;
  }
  // Listeners live here for the same reason: a fresh instance has none.
  chart.value.on("datazoom", (params: unknown) => {
    // A window only on a time axis, which is the only kind with an extent; the
    // button on any.
    zoomWindow = lastExtent ? windowFromEvent(params, lastExtent) : null;
    zoomed.value = isZoomed(params, lastExtent);
  });
  // On every frame drawn rather than on `finished`, which waits out the series
  // animation: a zoom changes which y labels are visible, and so how wide the
  // gutter is, and for the length of the animation the button would sit where
  // the slider used to begin. Cheap — one rect read, nothing cloned.
  chart.value.on("rendered", placeReset);
  // One event covers show, move and leave. ECharts dispatches
  // `updateAxisPointer` itself on `globalout`, with no axis in `axesInfo` — the
  // same shape it sends for a pointer over the legend or the zoom slider — so
  // there is no second handler to keep in step with this one.
  chart.value.on("updateAxisPointer", (event) => {
    const frame = props.frame;
    const axis = (event as { axesInfo?: { axisDim: string; value: number }[] })
      .axesInfo?.find((info) => info.axisDim === "x");
    if (!frame || isTimeIndex(frame) || !axis) {
      emitHover(null);
      return;
    }
    // For a category axis the value is the category's position.
    const raw = frame.index[Math.round(axis.value)];
    emitHover(raw === undefined ? null : String(normaliseIndexValue(raw)));
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
  emitHover(null);
  observer?.disconnect();
  const global = window as unknown as { __cgCharts?: Record<string, echarts.ECharts> };
  if (props.name && global.__cgCharts?.[props.name] === chart.value) {
    delete global.__cgCharts[props.name];
  }
  chart.value?.dispose();
  chart.value = null;
});

watch(() => props.frame, render);
watch(() => props.kind, render);
watch(unit, render);
// Deliberately *not* in `lastShape`: a precision change swaps two formatter
// functions and nothing else, which a merge absorbs. A replace here would
// rebuild every series on every keystroke in the field, for two formatters.
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
    <!-- A DOM control rather than ECharts' toolbox: that is drawn into the canvas
         in ECharts' own style, with no tooltip and no accessible name, and its
         `restore` re-applies the initial option — which now carries the window,
         so it would restore the zoom rather than remove it. Shown only while
         zoomed, where the reader is already looking: a permanently visible
         disabled control in the gutter is clutter. -->
    <div
      v-if="zoomed"
      class="absolute"
      :style="{ left: `${resetLeft}px`, bottom: `${resetBottom}px` }"
    >
      <TooltipButton
        :icon="RotateCcw"
        label="Reset zoom"
        size="xs"
        testid="zoom-reset"
        @click="resetZoom"
      />
    </div>
  </div>
</template>
