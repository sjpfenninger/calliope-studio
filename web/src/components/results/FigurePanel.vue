<script setup lang="ts">
/**
 * One figure of the results view: a splitter panel holding a titled card.
 *
 * The three figures wrapped themselves before this existed, in three copies of
 * the same fourteen lines — which is fine until the same three have to sit in
 * two different panel trees. The chrome is uniform for a load-bearing reason as
 * well as a tidy one: a collapsed panel has to be *exactly* its title bar, and
 * it cannot be if each figure wraps its card differently.
 *
 * Everything about sizing and collapsing comes from the `FIGURE_PANELS` context
 * rather than from props — see `composables/useFigurePanels`, which owns the
 * choreography for the whole tree because no single panel can know whether it is
 * the last one open.
 */
import { inject, onBeforeUnmount, ref } from "vue";

import Panel from "@/components/app/Panel.vue";
import PanelDisclosure from "@/components/app/PanelDisclosure.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import PanelTitle from "@/components/app/PanelTitle.vue";
import ProgressHairline from "@/components/app/ProgressHairline.vue";
import { ResizablePanel } from "@/components/ui/resizable";
import {
  FIGURE_PANELS,
  type ElementHandle,
  type PanelHandle,
} from "@/composables/useFigurePanels";
import type { ResultsFigure } from "@/lib/resultsLayouts";

const props = defineProps<{
  figure: ResultsFigure;
  /** The card's title, and what the disclosure says it collapses. */
  title: string;
  /** Named in the accessible label — "Collapse the map". */
  label: string;
  testid: string;
  /**
   * Whether a refetch is in flight, with data already on screen.
   *
   * `ResultChart` documents this behaviour — "on a refetch the old data stays on
   * screen and the panel header's `ProgressHairline` carries the fact that
   * something is happening" — as the reason it does not blank the chart or use
   * ECharts' own in-canvas spinner. The hairline was written for it and then
   * never mounted anywhere, so the calmer half of that trade was in place and
   * the informative half was not: a filter change simply looked like nothing
   * happening until the new numbers arrived.
   */
  busy?: boolean;
}>();

const panels = inject(FIGURE_PANELS)!;

const header = ref<ElementHandle | null>(null);
const panel = ref<PanelHandle | null>(null);

// Registered in setup rather than on mount: the context watches the registry, so
// it picks the refs up as soon as the template has filled them in.
panels.register(props.figure, { header, panel });
onBeforeUnmount(() => panels.unregister(props.figure));

const binding = panels.bindingFor(props.figure);
</script>

<template>
  <ResizablePanel
    ref="panel"
    v-bind="binding"
    @collapse="panels.onPanelState(props.figure, true)"
    @expand="panels.onPanelState(props.figure, false)"
  >
    <div class="h-full min-h-0 px-2 py-1">
      <Panel class="h-full" :data-testid="`figure-${props.figure}`">
        <PanelHeader ref="header" tone="card" wrap>
          <!-- `sm`, the height of the pickers beside it: at `xs` the figure's
               own title was a step smaller than its variable picker. -->
          <PanelDisclosure
            v-if="panels.isCollapsible(props.figure)"
            :label="props.label"
            :locked-reason="panels.lockedReason(props.figure)"
            :open="panels.isOpen(props.figure)"
            :testid="props.testid"
            size="sm"
            @toggle="panels.toggle(props.figure)"
          >
            {{ props.title }}
          </PanelDisclosure>
          <!-- Side by side there is nothing to fold to: a horizontally collapsed
               card would need a horizontal title bar. The title keeps the
               chevron's box so the header's controls do not shift when the
               layout changes under them. -->
          <span v-else class="flex h-6 min-w-0 shrink-0 items-center px-1">
            <PanelTitle>{{ props.title }}</PanelTitle>
          </span>

          <slot name="controls" />
        </PanelHeader>

        <ProgressHairline :active="props.busy" />

        <div
          v-show="panels.isOpen(props.figure)"
          class="relative flex min-h-0 flex-1 flex-col"
        >
          <slot />
        </div>
      </Panel>
    </div>
  </ResizablePanel>
</template>
