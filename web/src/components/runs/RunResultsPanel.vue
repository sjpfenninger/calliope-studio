<script setup lang="ts">
/**
 * The charts and map for one set of results.
 *
 * From `views/ResultsView.vue`, which was a route of its own with its own fixed
 * filter column. It is a *pane* now: one per run tab, kept alive when the tab
 * goes to the background, so switching between two runs issues no new frame
 * request at all — the invariant the whole per-handle store design exists to
 * make true.
 *
 * The handle is a prop and never changes for the life of this component (the tab
 * body keys on it), so the store is resolved once in setup and provided to the
 * panels below rather than each of them re-deriving it.
 *
 * The three figures are three panels of one splitter, each collapsible to its own
 * title bar. They used to be a map panel above a scrolling column holding both
 * charts, which meant the only thing the splitter could say was how much room the
 * map got: the two charts always shared whatever was left, and neither could be
 * put away to concentrate on the other.
 */
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";

import MapLegend from "@/components/map/MapLegend.vue";
import ModelMap from "@/components/map/ModelMap.vue";
import PanelDisclosure from "@/components/app/PanelDisclosure.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import ResultChart from "@/components/results/ResultChart.vue";
import RunFilterPanel from "./RunFilterPanel.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useResultFrame } from "@/composables/useResultFrame";
import { resolvedColor } from "@/lib/cssColor";
import { nodeSlices, nodeTotals, valueExtent } from "@/lib/mapValues";
import {
  RESOLUTIONS,
  RUN_SELECTION,
  useRunSelection,
  type MapChannel,
  type PlotType,
  type SumBy,
} from "@/stores/runSelection";
import { useUiStore, type ResultsFigure } from "@/stores/ui";

const props = defineProps<{ handle: string }>();

const ui = useUiStore();

const store = useRunSelection(props.handle);
provide(RUN_SELECTION, store);

const handle = computed(() => props.handle);

const timeseriesFrame = useResultFrame(
  handle,
  computed(() => store.timeseriesQuery),
);
const staticFrame = useResultFrame(
  handle,
  computed(() => store.staticQuery),
);
const mapSizeFrame = useResultFrame(
  handle,
  computed(() => store.mapSizeQuery),
);
const mapColorFrame = useResultFrame(
  handle,
  computed(() => store.mapColorQuery),
);
const mapPieFrame = useResultFrame(
  handle,
  computed(() => store.mapPieQuery),
);

// The reduction from a nodes-indexed frame to what the map draws lives in
// `lib/mapValues`, tested: there are three channels wanting it now, and a marker
// sized from the wrong series is still a perfectly plausible-looking marker.
const mapSizes = computed(() => nodeTotals(mapSizeFrame.frame.value));
const mapColors = computed(() => nodeTotals(mapColorFrame.frame.value));
const mapPies = computed(() =>
  store.mapVariables.pie ? nodeSlices(mapPieFrame.frame.value) : null,
);

const PLOT_TYPES: PlotType[] = ["Bar", "Line", "Area", "Duration"];
const resolutions = Object.keys(RESOLUTIONS);

/** How each sum-by option is labelled, in the order the toggle offers them. */
const SUM_LABELS: Record<SumBy, string> = {
  none: "No sum",
  nodes: "Sum nodes",
  techs: "Sum techs",
};

/**
 * Shorter labels for the resolutions, where the key is the API into `RESOLUTIONS`
 * and not a caption.
 *
 * "Original resolution" alone is wide enough to push this header onto a second
 * row, which makes the time series' title bar half as tall again as the two
 * beside it — and a collapsed figure is exactly its title bar, so the difference
 * is not only visible while everything is open.
 */
const RESOLUTION_LABELS: Record<string, string> = {
  "Original resolution": "Original",
};

const timeseriesVariables = computed(
  () => store.catalog?.variables.timeseries ?? [],
);
const staticVariables = computed(() => store.catalog?.variables.static ?? []);

/**
 * What the map's channels may be set to.
 *
 * Only variables carrying node data: everything else has nothing to put on a
 * node. The catalogue has always computed this list and nothing used it.
 */
const mapVariables = computed(() => store.catalog?.variables.static_nodes ?? []);

/**
 * The sentinel a `Select` uses for "no variable" — it cannot bind to null.
 *
 * Underscored rather than something prettier because it shares a value space
 * with variable names, and no Calliope variable is called this.
 */
const NONE = "__none__";

function channelValue(channel: MapChannel): string {
  return store.mapVariables[channel] ?? NONE;
}

function setChannel(channel: MapChannel, value: string) {
  store.mapVariables[channel] = value === NONE ? null : value;
}

// ── The legend ─────────────────────────────────────────────────────────────

const ramp = ref<string[]>([]);

/**
 * The ramp, re-read on every theme change.
 *
 * The swatches are DOM and could have used `var(--cg-chart-N)` directly, but the
 * map resolves the same tokens through `lib/cssColor` for its canvas — and a
 * legend whose colours are arrived at by a different route is a legend that can
 * disagree with the thing it explains.
 */
watch(
  () => ui.revision,
  () => {
    ramp.value = [1, 2, 3, 4, 5].map((step) =>
      resolvedColor(`--cg-chart-${step}`, "#055bcc"),
    );
  },
  { immediate: true },
);

const pieTechs = computed(() => {
  const pies = mapPies.value;
  if (!pies) return [];
  const seen = new Map<string, { key: string; label: string; color: string }>();
  for (const slices of Object.values(pies)) {
    for (const slice of slices) {
      if (seen.has(slice.key)) continue;
      seen.set(slice.key, {
        key: slice.key,
        // Links go by their endpoints, exactly as they do in the chart legends.
        label: store.techLabels[slice.key] ?? slice.key,
        color: slice.color ?? ramp.value[0] ?? "",
      });
    }
  }
  return [...seen.values()];
});

// ── Panels: sizing and collapsing ──────────────────────────────────────────

/** Three figures, or two when the model has no geography to map. */
const panelCount = computed(() => (store.hasGeography ? 3 : 2));
const sizes = computed(() => ui.resultsSplitFor(panelCount.value));

/**
 * What a panel costs on top of its header: `py-1` above and below the card, plus
 * the card's own hairline top and bottom.
 *
 * Uniform across the three, which is why they all carry the same padding — a
 * collapsed panel has to be *exactly* its title bar, and it cannot be if each
 * panel wraps its card differently.
 */
const PANEL_CHROME_PX = 8 + 2;

/** A resize handle's own hairline, which is not part of any panel's share. */
const HANDLE_PX = 1;

/** Below this a chart has no plot area left, only insets and a zoom slider. */
const FLOOR_PX = 150;

const frame = ref<HTMLElement | null>(null);
const groupHeight = ref(0);

const mapHeader = ref<{ $el?: HTMLElement } | null>(null);
const timeseriesHeader = ref<{ $el?: HTMLElement } | null>(null);
const staticHeader = ref<{ $el?: HTMLElement } | null>(null);

const headers: Record<ResultsFigure, typeof mapHeader> = {
  map: mapHeader,
  timeseries: timeseriesHeader,
  static: staticHeader,
};

/**
 * Each header's height, measured.
 *
 * Not a constant, which is what made a collapsed figure clip its own title bar:
 * the two chart headers carry enough controls to wrap onto a second row at a
 * narrow width, so "a header is 28px" was true of the map and of neither of the
 * others. What a collapsed panel has to be is *this* header, right now.
 */
const headerHeights = ref<Record<ResultsFigure, number>>({
  map: 0,
  timeseries: 0,
  static: 0,
});

/**
 * The height the panels actually divide between them.
 *
 * Not the group's own height: the resize handles are laid out beside the panels
 * and a panel's percentage is of what is left after them. One pixel each, but a
 * collapsed figure has to be its title bar exactly — a pixel out and the bottom
 * hairline of the strip is the first thing to go.
 */
const availableHeight = computed(() =>
  Math.max(0, groupHeight.value - (panelCount.value - 1) * HANDLE_PX),
);

const collapsedPct = computed<Record<ResultsFigure, number>>(() => {
  const of = (figure: ResultsFigure) =>
    availableHeight.value > 0 && headerHeights.value[figure] > 0
      ? ((headerHeights.value[figure] + PANEL_CHROME_PX) / availableHeight.value) *
        100
      : 5;
  return { map: of("map"), timeseries: of("timeseries"), static: of("static") };
});

/**
 * The smallest a figure may be dragged to before it snaps shut.
 *
 * Always clear of its own collapsed size: reka cannot tell "as small as it goes"
 * from "collapsed" if the two coincide, and a figure that can be dragged to
 * exactly its title bar without registering as collapsed leaves the chevron
 * pointing the wrong way.
 */
function floorFor(figure: ResultsFigure): number {
  if (availableHeight.value <= 0) return 15;
  return Math.max(
    (FLOOR_PX / availableHeight.value) * 100,
    collapsedPct.value[figure] + 2,
  );
}

/**
 * A collapsed figure is pinned to its title bar, top and bottom.
 *
 * Collapsing a panel does not make its space disappear — the splitter has to give
 * it to a neighbour, and it will happily give it to a panel that is *itself*
 * collapsed, which silently reopened it. Collapsing the time series and then the
 * totals reopened the time series, so "collapse both" was not a thing that could
 * be done. Pinning `minSize` and `maxSize` together leaves the splitter nowhere
 * to put the slack except a figure that is actually open.
 */
function minFor(figure: ResultsFigure): number {
  return ui.resultsCollapsed[figure] ? collapsedPct.value[figure] : floorFor(figure);
}

function maxFor(figure: ResultsFigure): number {
  return ui.resultsCollapsed[figure] ? collapsedPct.value[figure] : 100;
}

/** The figures on screen — the map only when there is geography to put on it. */
const visibleFigures = computed<ResultsFigure[]>(() =>
  store.hasGeography ? FIGURES : FIGURES.filter((figure) => figure !== "map"),
);

/**
 * Why a figure cannot be collapsed, or empty when it can.
 *
 * The last open figure has to stay open: the panels divide a fixed height between
 * them, so if every one of them were pinned to its title bar there would be a
 * band of space with nothing entitled to it, and one figure would be handed it —
 * showing an empty card under its own title. Keeping one open is also what the
 * feature is for; collapsing everything focuses on nothing.
 */
function lockedReason(figure: ResultsFigure): string {
  if (ui.resultsCollapsed[figure]) return "";
  const open = visibleFigures.value.filter((name) => !ui.resultsCollapsed[name]);
  return open.length > 1 ? "" : "Expand another figure first — one has to stay open.";
}

let observer: ResizeObserver | null = null;

function measure() {
  const heights = { ...headerHeights.value };
  for (const figure of FIGURES) {
    const element = headers[figure].value?.$el;
    if (element) heights[figure] = element.getBoundingClientRect().height;
  }
  headerHeights.value = heights;
}

// One observer for the group and all three headers: they change together (a
// window resize reflows the wrapped headers *and* the group), and a single
// callback cannot see a half-updated set.
watch(
  [frame, mapHeader, timeseriesHeader, staticHeader],
  ([element]) => {
    observer?.disconnect();
    observer = null;
    if (!element) return;
    observer = new ResizeObserver(() => {
      groupHeight.value = element.getBoundingClientRect().height;
      measure();
    });
    observer.observe(element);
    for (const figure of FIGURES) {
      const header = headers[figure].value?.$el;
      if (header) observer.observe(header);
    }
  },
  { flush: "post" },
);

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

/**
 * What reka exposes on a panel, which `SplitterPanelProps` does not describe.
 *
 * `ResizablePanel` forwards its child's exposed methods through
 * `useForwardExpose`, so these reach `SplitterPanel` — but the wrapper's props
 * type says nothing about them, hence the cast at each ref.
 */
type PanelHandle = {
  collapse: () => void;
  expand: () => void;
  /** The panel element, which carries reka's own `data-state`. */
  $el?: HTMLElement;
};

// Three refs rather than one keyed object: a template `ref="..."` binds by
// matching a top-level name, so `ref="panels.map"` would bind to nothing at all.
const mapPanel = ref<PanelHandle | null>(null);
const timeseriesPanel = ref<PanelHandle | null>(null);
const staticPanel = ref<PanelHandle | null>(null);

const panels: Record<ResultsFigure, typeof mapPanel> = {
  map: mapPanel,
  timeseries: timeseriesPanel,
  static: staticPanel,
};

const FIGURES: ResultsFigure[] = ["map", "timeseries", "static"];

/**
 * Whether a collapse is being driven by the store rather than by the user.
 *
 * The panel emits `@collapse` when told to collapse, so without this the store
 * write and the panel call chase each other round once on every toggle.
 */
let syncing = false;

/**
 * Whether the stored state has been pushed into the panels yet.
 *
 * A panel emits `@expand` as it registers, which arrives *before* anything has
 * had a chance to tell it that this figure was left collapsed — so without this
 * every reload wrote "expanded" over the state it was about to restore, and the
 * collapse survived exactly as long as it took the panel to mount.
 */
let restored = false;

function toggle(figure: ResultsFigure) {
  ui.setResultsCollapsed(figure, !ui.resultsCollapsed[figure]);
}

function onPanelState(figure: ResultsFigure, collapsed: boolean) {
  if (syncing || !restored) return;
  ui.setResultsCollapsed(figure, collapsed);
}

/**
 * Pushes the stored state into the panels.
 *
 * Watches the refs as well as the state, because the map panel only mounts once
 * the geography has arrived — a beat after everything else — and until its ref
 * resolves there is nothing to collapse.
 */
watch(
  [
    () => ({ ...ui.resultsCollapsed }),
    mapPanel,
    timeseriesPanel,
    staticPanel,
    groupHeight,
  ],
  ([state, , , , height]) => {
    // Not before the group has a height: reka throws "Panel size not found" if a
    // panel is collapsed before the layout it belongs to has been computed, and
    // the observer only fires once that has happened.
    if (!height) return;

    syncing = true;
    for (const figure of FIGURES) {
      const panel = panels[figure].value;
      if (!panel) continue;
      // Its own `data-state` rather than a shadow copy: reka snaps a panel
      // dragged below `minSize` to collapsed on its own, so this component is
      // not the only thing that changes it.
      const collapsed = panel.$el?.dataset.state === "collapsed";
      if (collapsed === state[figure]) continue;
      if (state[figure]) panel.collapse();
      else panel.expand();
    }
    // After the layout has settled, not before: reka resizes synchronously but
    // emits on the next tick.
    queueMicrotask(() => {
      syncing = false;
      restored = true;
    });
  },
  // `post`, so the pinned `min-size`/`max-size` a collapsed figure carries have
  // been re-rendered before `expand()` is called. Run before them and the panel
  // is told to expand while still capped at its title bar, and reka does the only
  // thing it can: leaves it shut.
  { deep: true, immediate: true, flush: "post" },
);


/**
 * A model with no geography mounts two panels rather than three, and the
 * splitter emits a two-element layout for it. Those are stored separately, so
 * one cannot overwrite the other with a layout of the wrong shape.
 */
function onLayout(layout: number[]) {
  ui.setResultsSplit(layout);
}

// `load` is idempotent, so a pane rebuilt after an LRU teardown restores the
// user's filters instead of resetting them.
onMounted(() => store.load());

/**
 * Reproduces PrimeVue's `:allow-empty="false"`.
 *
 * A toggle group deselects on a second click, and "no plot type" is not a state
 * this view has — it would blank the chart with no way back except guessing.
 */
function keepOne<T extends string>(next: unknown, current: T): T {
  return (next as T) || current;
}
</script>

<template>
  <div class="flex min-h-0 flex-1" data-testid="run-results">
    <RunFilterPanel class="w-52 shrink-0" />

    <main class="flex min-h-0 flex-1 flex-col">
      <p
        v-if="store.error"
        class="m-2 rounded-sm bg-danger-soft p-2 text-sm text-danger-text"
      >
        {{ store.error }}
      </p>

      <!-- Held back until the geography question has been answered, one way or
           the other. A splitter reads a panel's `defaultSize` when the panel
           *registers*, so a map panel appearing a beat later registers into a
           layout computed without it and the stored split is quietly replaced by
           a redistribution. `geoResolved` flips false→true exactly once and never
           back, so this mounts once — unlike a `v-if` on `hasGeography`, which
           would remount the charts and the map on every results open. The frames
           are fetched by this component, not by the panels, so nothing here
           re-requests anything. -->
      <StateMessage
        v-if="!store.geoResolved"
        variant="fill"
        loading
        data-testid="results-loading"
      >
        Reading results…
      </StateMessage>
      <div v-else class="flex min-h-0 flex-1 flex-col py-1">
      <div ref="frame" class="flex min-h-0 flex-1 flex-col">
      <ResizablePanelGroup
        direction="vertical"
        class="min-h-0 flex-1"
        @layout="onLayout"
      >
        <!-- `order` is not cosmetic. Reka sorts its panels by it and otherwise
             falls back to *registration* order, and this panel is conditional, so
             it always registers second — leaving the map holding the charts' size
             and the stored layout transposed against the one on screen. -->
        <ResizablePanel
          v-if="store.hasGeography"
          ref="mapPanel"
          :order="1"
          :default-size="sizes[0]"
          :min-size="minFor('map')"
          :max-size="maxFor('map')"
          :collapsed-size="collapsedPct.map"
          collapsible
          @collapse="onPanelState('map', true)"
          @expand="onPanelState('map', false)"
        >
          <div class="h-full min-h-0 px-2 py-1">
            <section
              class="flex h-full min-h-0 flex-col rounded-sm border border-border bg-surface"
            >
              <PanelHeader ref="mapHeader" tone="card" wrap class="gap-2">
                <PanelDisclosure
                  label="the map"
                  :locked-reason="lockedReason('map')"
                  :open="!ui.resultsCollapsed.map"
                  testid="collapse-map"
                  @toggle="toggle('map')"
                >
                  Map
                </PanelDisclosure>

                <!-- One picker per encoding channel. All three set to None is a
                     real answer, not an empty state: the nodes stay on the map at
                     a uniform size, which says where the model is and claims
                     nothing about how much is at each node. -->
                <Select
                  v-for="channel in (['size', 'color', 'pie'] as MapChannel[])"
                  :key="channel"
                  :model-value="channelValue(channel)"
                  :disabled="channel === 'color' && Boolean(store.mapVariables.pie)"
                  @update:model-value="
                    (value) => setChannel(channel, String(value ?? NONE))
                  "
                >
                  <SelectTrigger
                    size="sm"
                    class="w-32"
                    :data-testid="`map-${channel}-variable`"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="NONE">
                      {{ { size: "No size", color: "No colour", pie: "No pie" }[channel] }}
                    </SelectItem>
                    <SelectItem v-for="name in mapVariables" :key="name" :value="name">
                      {{ name }}
                    </SelectItem>
                  </SelectContent>
                </Select>

                <div class="flex-1" />
                <template v-if="store.mapNodes.length">
                  <span class="truncate text-2xs text-text-faint">
                    Charts narrowed to {{ store.mapNodes.join(", ") }}
                  </span>
                  <button
                    type="button"
                    class="rounded-xs px-1 text-2xs text-accent-text hover:bg-hover"
                    @click="store.mapNodes = []"
                  >
                    Clear
                  </button>
                </template>
                <span v-else class="shrink-0 text-2xs text-text-faint">
                  Click nodes to narrow the charts.
                </span>
              </PanelHeader>

              <!-- No `height`: the default is already 100%, and the panel is what
                   decides it now. MapLibre tracks its container, so the drag
                   drives the map with no extra wiring. -->
              <div v-show="!ui.resultsCollapsed.map" class="relative min-h-0 flex-1">
                <ModelMap
                  v-model:selected="store.mapNodes"
                  :geo="store.geo"
                  :values="mapSizes"
                  :color-values="mapColors"
                  :pies="mapPies"
                  :value-label="store.mapVariables.size ?? ''"
                  class="h-full"
                />
                <MapLegend
                  :size-label="store.mapVariables.size"
                  :size-extent="valueExtent(mapSizes)"
                  :color-label="store.mapVariables.pie ? null : store.mapVariables.color"
                  :color-extent="valueExtent(mapColors)"
                  :ramp="ramp"
                  :pie-label="store.mapVariables.pie"
                  :pie-techs="pieTechs"
                />
              </div>
            </section>
          </div>
        </ResizablePanel>

        <ResizableHandle
          v-if="store.hasGeography"
          with-handle
          data-testid="results-split-handle"
        />

        <ResizablePanel
          ref="timeseriesPanel"
          :order="2"
          :default-size="sizes[store.hasGeography ? 1 : 0]"
          :min-size="minFor('timeseries')"
          :max-size="maxFor('timeseries')"
          :collapsed-size="collapsedPct.timeseries"
          collapsible
          @collapse="onPanelState('timeseries', true)"
          @expand="onPanelState('timeseries', false)"
        >
          <div class="h-full min-h-0 px-2 py-1">
            <section
              class="flex h-full min-h-0 flex-col rounded-sm border border-border bg-surface"
            >
              <PanelHeader ref="timeseriesHeader" tone="card" wrap>
                <PanelDisclosure
                  label="the time series"
                  :locked-reason="lockedReason('timeseries')"
                  :open="!ui.resultsCollapsed.timeseries"
                  testid="collapse-timeseries"
                  @toggle="toggle('timeseries')"
                >
                  Time series
                </PanelDisclosure>

                <Select v-model="store.variableTimeseries">
                  <SelectTrigger size="sm" class="w-36" data-testid="timeseries-variable">
                    <SelectValue placeholder="Variable" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="name in timeseriesVariables"
                      :key="name"
                      :value="name"
                    >
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
                  @update:model-value="
                    (value) => (store.plotType = keepOne(value, store.plotType))
                  "
                >
                  <ToggleGroupItem
                    v-for="type in PLOT_TYPES"
                    :key="type"
                    :value="type"
                  >
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
                    (value) =>
                      (store.resolution = keepOne(value, store.resolution))
                  "
                >
                  <ToggleGroupItem
                    v-for="name in resolutions"
                    :key="name"
                    :value="name"
                  >
                    {{ RESOLUTION_LABELS[name] ?? name }}
                  </ToggleGroupItem>
                </ToggleGroup>

                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  data-testid="sum-by"
                  :model-value="store.sumBy"
                  @update:model-value="
                    (value) => (store.sumBy = keepOne(value, store.sumBy))
                  "
                >
                  <ToggleGroupItem value="nodes">Sum nodes</ToggleGroupItem>
                  <ToggleGroupItem value="techs">Sum techs</ToggleGroupItem>
                </ToggleGroup>
              </PanelHeader>

              <ResultChart
                v-show="!ui.resultsCollapsed.timeseries"
                :frame="timeseriesFrame.frame.value"
                :kind="store.timeseriesKind"
                :loading="timeseriesFrame.loading.value"
                :error="timeseriesFrame.error.value"
                :labels="store.techLabels"
                height="100%"
                class="min-h-0 flex-1"
              />
            </section>
          </div>
        </ResizablePanel>

        <ResizableHandle with-handle data-testid="results-charts-handle" />

        <ResizablePanel
          ref="staticPanel"
          :order="3"
          :default-size="sizes[store.hasGeography ? 2 : 1]"
          :min-size="minFor('static')"
          :max-size="maxFor('static')"
          :collapsed-size="collapsedPct.static"
          collapsible
          @collapse="onPanelState('static', true)"
          @expand="onPanelState('static', false)"
        >
          <div class="h-full min-h-0 px-2 py-1">
            <section
              class="flex h-full min-h-0 flex-col rounded-sm border border-border bg-surface"
            >
              <PanelHeader ref="staticHeader" tone="card" wrap>
                <PanelDisclosure
                  label="the totals chart"
                  :locked-reason="lockedReason('static')"
                  :open="!ui.resultsCollapsed.static"
                  testid="collapse-static"
                  @toggle="toggle('static')"
                >
                  Totals
                </PanelDisclosure>

                <Select v-model="store.variableStatic">
                  <SelectTrigger size="sm" class="w-36" data-testid="static-variable">
                    <SelectValue placeholder="Variable" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="name in staticVariables"
                      :key="name"
                      :value="name"
                    >
                      {{ name }}
                    </SelectItem>
                  </SelectContent>
                </Select>

                <!-- Only the aggregations this variable's dimensions allow: the
                     server drops a `sum_by` naming a dimension the array does not
                     have, silently, so an option that cannot work would look set
                     while doing nothing. -->
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  data-testid="static-sum-by"
                  :model-value="store.staticSumBy"
                  @update:model-value="
                    (value) =>
                      (store.staticSumBy = keepOne(value, store.staticSumBy))
                  "
                >
                  <ToggleGroupItem
                    v-for="option in store.staticSumOptions"
                    :key="option"
                    :value="option"
                  >
                    {{ SUM_LABELS[option] }}
                  </ToggleGroupItem>
                </ToggleGroup>
              </PanelHeader>

              <ResultChart
                v-show="!ui.resultsCollapsed.static"
                :frame="staticFrame.frame.value"
                kind="bar"
                :loading="staticFrame.loading.value"
                :error="staticFrame.error.value"
                :labels="store.techLabels"
                height="100%"
                class="min-h-0 flex-1"
              />
            </section>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      </div>
      </div>
    </main>
  </div>
</template>
