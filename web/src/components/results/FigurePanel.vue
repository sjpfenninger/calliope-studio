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

import PanelDisclosure from "@/components/app/PanelDisclosure.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import PanelTitle from "@/components/app/PanelTitle.vue";
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
      <section
        class="flex h-full min-h-0 flex-col rounded-sm border border-border bg-surface"
        :data-testid="`figure-${props.figure}`"
      >
        <PanelHeader ref="header" tone="card" wrap class="gap-2">
          <PanelDisclosure
            v-if="panels.isCollapsible(props.figure)"
            :label="props.label"
            :locked-reason="panels.lockedReason(props.figure)"
            :open="panels.isOpen(props.figure)"
            :testid="props.testid"
            @toggle="panels.toggle(props.figure)"
          >
            {{ props.title }}
          </PanelDisclosure>
          <!-- Side by side there is nothing to fold to: a horizontally collapsed
               card would need a horizontal title bar. The title keeps the
               chevron's box so the header's controls do not shift when the
               layout changes under them. -->
          <span v-else class="flex h-5 min-w-0 shrink-0 items-center px-1">
            <PanelTitle>{{ props.title }}</PanelTitle>
          </span>

          <slot name="controls" />
        </PanelHeader>

        <div
          v-show="panels.isOpen(props.figure)"
          class="relative flex min-h-0 flex-1 flex-col"
        >
          <slot />
        </div>
      </section>
    </div>
  </ResizablePanel>
</template>
