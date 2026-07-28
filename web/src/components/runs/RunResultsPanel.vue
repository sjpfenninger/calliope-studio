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
 * **Every frame is fetched here** and passed down. That is what makes switching
 * layout — or sub-view, or tab — cost nothing: the figures own their controls
 * and their export button, but none of them owns a request.
 *
 * The panel tree is one tree in two directions:
 *
 *     group "main"  (vertical | horizontal)
 *       ├─ MapFigure
 *       └─ group "charts"  (always vertical)
 *            ├─ TimeseriesFigure
 *            └─ TotalsFigure
 *
 * A model with no geography renders the `charts` group as the root. See
 * `composables/useFigurePanels` for the sizing and collapsing, and
 * `lib/resultsLayouts` for what a layout is and why each one owns its geometry.
 */
import { computed, onMounted, provide } from "vue";

import MapFigure from "@/components/results/MapFigure.vue";
import ResultsLayoutBar from "@/components/results/ResultsLayoutBar.vue";
import RunFilterPanel from "./RunFilterPanel.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import TimeseriesFigure from "@/components/results/TimeseriesFigure.vue";
import TotalsFigure from "@/components/results/TotalsFigure.vue";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { FIGURE_PANELS, useFigurePanels } from "@/composables/useFigurePanels";
import { useResultFrame } from "@/composables/useResultFrame";
import { findLayout, type ResultsLayoutId } from "@/lib/resultsLayouts";
import { RUN_SELECTION, useRunSelection } from "@/stores/runSelection";
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

/**
 * The layout on screen, which is not always the one stored.
 *
 * A model with no geography cannot show a layout built around the map, so it
 * falls back — without writing that back, so opening a model that *does* have
 * geography finds the user's choice where they left it.
 */
const activeLayout = computed<ResultsLayoutId>(() => {
  const layout = findLayout(ui.resultsLayout);
  return layout.needsMap && !store.hasGeography ? "stacked" : layout.id;
});

const direction = computed(() => findLayout(activeLayout.value).direction);

const hasMap = computed(() => store.hasGeography);

// Destructured because `mainEl` and `chartsEl` are template refs, and a template
// `ref="…"` binds by matching a *top-level* name — `panels.mainEl` would bind to
// nothing at all.
const { context, mainEl, chartsEl, chartsColumnBinding, onLayout } = useFigurePanels({
  hasMap,
  layoutId: activeLayout,
  direction,
  geometry: computed(() => ui.resultsGeometryNow),
  setCollapsed: ui.setResultsCollapsed,
  setSizes: ui.setResultsSizes,
});

provide(FIGURE_PANELS, context);

// `load` is idempotent, so a pane rebuilt after an LRU teardown restores the
// user's filters instead of resetting them.
onMounted(() => store.load());
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
           layout computed without it and the stored geometry is quietly replaced
           by a redistribution. `geoResolved` flips false→true exactly once and
           never back, so this mounts once — unlike a `v-if` on `hasGeography`,
           which would remount the charts and the map on every results open. The
           frames are fetched by this component, not by the panels, so nothing
           here re-requests anything. -->
      <StateMessage
        v-if="!store.geoResolved"
        variant="fill"
        loading
        data-testid="results-loading"
      >
        Reading results…
      </StateMessage>

      <template v-else>
        <ResultsLayoutBar :active="activeLayout" />

        <!-- The wrappers carry the refs, not the groups: a template ref on a
             component yields the instance, and what has to be measured is the
             box the panels divide. -->
        <div class="flex min-h-0 flex-1 flex-col py-1">
        <div ref="mainEl" class="flex min-h-0 flex-1">
          <!-- `direction` is a prop rather than a second panel tree: reka reads
               it reactively and the sizes are percentages, so flipping it
               rearranges the panels that are already mounted. Two trees behind a
               `v-if` would tear down MapLibre and both ECharts instances on every
               layout switch, and the map would lose the viewport the user panned
               to.

               A model with no geography renders the same group with the map
               panel left out, so the charts are never rebuilt and there is one
               tree rather than two nearly-identical ones. -->
          <ResizablePanelGroup
            :direction="direction"
            class="min-h-0 flex-1"
            data-testid="results-main-group"
            @layout="onLayout('main', $event)"
          >
            <MapFigure
              v-if="store.hasGeography"
              :size-frame="mapSizeFrame.frame.value"
              :color-frame="mapColorFrame.frame.value"
              :pie-frame="mapPieFrame.frame.value"
              :size-unit="mapSizeFrame.unit.value"
              :color-unit="mapColorFrame.unit.value"
              :pie-unit="mapPieFrame.unit.value"
            />

            <!-- No hairline of its own: each figure is a bordered card, so the
                 handle's line made three parallel rules where one boundary is.
                 The grip is the affordance, and it is the only one that has to be
                 there. The editors' splitters keep theirs — nothing on either
                 side of those is a card, so there the line *is* the boundary. -->
            <ResizableHandle
              v-if="store.hasGeography"
              with-handle
              class="bg-transparent"
              data-testid="results-split-handle"
            />

            <ResizablePanel v-bind="chartsColumnBinding">
              <div ref="chartsEl" class="flex h-full min-h-0 flex-col">
                <ResizablePanelGroup
                  direction="vertical"
                  class="min-h-0 flex-1"
                  data-testid="results-charts-group"
                  @layout="onLayout('charts', $event)"
                >
                  <TimeseriesFigure
                    :frame="timeseriesFrame.frame.value"
                    :loading="timeseriesFrame.loading.value"
                    :error="timeseriesFrame.error.value"
                    :unit="timeseriesFrame.unit.value"
                  />
                  <ResizableHandle
                    with-handle
                    class="bg-transparent"
                    data-testid="results-charts-handle"
                  />
                  <TotalsFigure
                    :frame="staticFrame.frame.value"
                    :loading="staticFrame.loading.value"
                    :error="staticFrame.error.value"
                    :unit="staticFrame.unit.value"
                  />
                </ResizablePanelGroup>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
        </div>
      </template>
    </main>
  </div>
</template>
