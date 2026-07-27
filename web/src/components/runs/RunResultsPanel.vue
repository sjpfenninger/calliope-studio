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
 */
import { computed, onMounted, provide } from "vue";

import ModelMap from "@/components/map/ModelMap.vue";
import ResultChart from "@/components/results/ResultChart.vue";
import RunFilterPanel from "./RunFilterPanel.vue";
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
import {
  RESOLUTIONS,
  RUN_SELECTION,
  useRunSelection,
  type PlotType,
} from "@/stores/runSelection";
import { useUiStore } from "@/stores/ui";

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
const mapFrame = useResultFrame(
  handle,
  computed(() => store.mapQuery),
);

/**
 * Per-node totals for the map, keyed by node.
 *
 * The map query is indexed by node and summed over technologies, so each series
 * is one node and its first value is that node's total.
 */
const mapValues = computed<Record<string, number>>(() => {
  const frame = mapFrame.frame.value;
  if (!frame) return {};
  const totals: Record<string, number> = {};
  frame.index.forEach((node, position) => {
    const sum = frame.series.reduce((running, series) => {
      const value = series.values[position];
      return Number.isNaN(value) ? running : running + value;
    }, 0);
    if (sum !== 0) totals[String(node)] = sum;
  });
  return totals;
});

const PLOT_TYPES: PlotType[] = ["Bar", "Line", "Area", "Duration"];
const resolutions = Object.keys(RESOLUTIONS);

const timeseriesVariables = computed(
  () => store.catalog?.variables.timeseries ?? [],
);
const staticVariables = computed(() => store.catalog?.variables.static ?? []);

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

/**
 * A model with no geography mounts one panel rather than two, and the splitter
 * emits a one-element layout for it. Persisting that would wipe the split the user
 * set on a model that does have a map. The store checks the length too.
 */
function onLayout(sizes: number[]) {
  if (sizes.length === 2) ui.setResultsSplit(sizes);
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

      <!-- One panel group, always mounted, with only the map panel conditional.
           `load()` awaits the catalogue before the geography, so `hasGeography`
           always flips false→true a moment after this mounts; `v-if`-ing the whole
           group would remount the charts on every results open, tearing down both
           `useResultFrame` scopes and refetching every frame. -->
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
          :order="1"
          :default-size="ui.resultsSplit[0]"
          :min-size="15"
        >
          <div class="h-full min-h-0 p-2 pb-1">
            <section
              class="flex h-full min-h-0 flex-col rounded-sm border border-border bg-surface"
            >
              <header
                class="flex h-7 shrink-0 items-center gap-2 border-b border-border-subtle px-2"
              >
                <span class="text-sm font-medium">
                  {{ store.variableStatic }} by node
                </span>
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
                <span v-else class="text-2xs text-text-faint">
                  Click nodes to narrow the charts below.
                </span>
              </header>
              <!-- No `height`: the default is already 100%, and the panel is what
                   decides it now. MapLibre tracks its container, so the drag
                   drives the map with no extra wiring. -->
              <ModelMap
                v-model:selected="store.mapNodes"
                :geo="store.geo"
                :values="mapValues"
                class="min-h-0 flex-1"
              />
            </section>
          </div>
        </ResizablePanel>

        <ResizableHandle
          v-if="store.hasGeography"
          with-handle
          data-testid="results-split-handle"
        />

        <!-- The scroll lives on this inner div, not on the panel: Reka's splitter
             panel sets `overflow: hidden` on itself. -->
        <ResizablePanel
          :order="2"
          :default-size="ui.resultsSplit[1]"
          :min-size="25"
        >
          <div
            class="flex h-full flex-col gap-2 overflow-y-auto p-2"
            :class="store.hasGeography && 'pt-1'"
          >
            <!-- `flex-1` with a floor rather than a fixed height: shrinking the map
                 should give the charts the room, but below about 160px the fixed
                 grid insets and the zoom slider leave no plot area at all. The
                 sections deliberately keep the default `min-height: auto`, which is
                 what carries that floor up and makes this column scroll instead of
                 squashing both charts. -->
            <section
              class="flex flex-1 flex-col rounded-sm border border-border bg-surface"
            >
              <header
                class="flex min-h-7 flex-wrap items-center gap-1.5 border-b border-border-subtle px-2 py-1"
              >
                <Select v-model="store.variableTimeseries">
                  <SelectTrigger
                    size="sm"
                    class="h-7 w-48"
                    data-testid="timeseries-variable"
                  >
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
                    {{ name }}
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
              </header>
              <ResultChart
                :frame="timeseriesFrame.frame.value"
                :kind="store.timeseriesKind"
                :loading="timeseriesFrame.loading.value"
                :error="timeseriesFrame.error.value"
                :labels="store.techLabels"
                height="100%"
                class="min-h-90 flex-1"
              />
            </section>

            <section
              class="flex flex-1 flex-col rounded-sm border border-border bg-surface"
            >
              <header
                class="flex h-9 shrink-0 items-center gap-1.5 border-b border-border-subtle px-2"
              >
                <Select v-model="store.variableStatic">
                  <SelectTrigger
                    size="sm"
                    class="h-7 w-48"
                    data-testid="static-variable"
                  >
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
              </header>
              <ResultChart
                :frame="staticFrame.frame.value"
                kind="bar"
                :loading="staticFrame.loading.value"
                :error="staticFrame.error.value"
                :labels="store.techLabels"
                height="100%"
                class="min-h-70 flex-1"
              />
            </section>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </main>
  </div>
</template>
