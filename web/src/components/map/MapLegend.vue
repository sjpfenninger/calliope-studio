<script setup lang="ts">
/**
 * What the markers on the map mean.
 *
 * A sequential colour ramp with no key is decoration rather than information —
 * the reader can see that one node is darker than another and has no way to know
 * by how much — so the colour channel cannot exist without this. Size and pies
 * get an entry for the same reason, though a size ramp is at least
 * self-explanatory once one node is hovered.
 *
 * An overlay rather than a strip in the header: the header is already carrying
 * three variable pickers, and a legend belongs beside what it explains. Bottom
 * left, which is the one corner MapLibre's own controls and attribution leave
 * alone.
 */
import { computed } from "vue";

import { formatCompact } from "@/lib/format";

const props = withDefaults(
  defineProps<{
    /** Variable on the size channel, if any, and the span it covers. */
    sizeLabel?: string | null;
    sizeExtent?: [number, number] | null;
    /** Variable on the colour channel, and its span. */
    colorLabel?: string | null;
    colorExtent?: [number, number] | null;
    /** The ramp itself, resolved by the map so both read the same tokens. */
    ramp?: string[];
    /** Variable drawn as pies, and the technologies making up the wedges. */
    pieLabel?: string | null;
    pieTechs?: { key: string; label: string; color: string }[];
    /**
     * Whether any node is wearing the selection ring.
     *
     * The ring is the one mark on the map that no channel explains, and the
     * legend is where marks are explained; it is shown only while there is one
     * to explain, since the layout bar already says how to make one.
     */
    selected?: boolean;
    /**
     * The reader's precision, which here only ever *tightens* the ends.
     *
     * See `formatCompact`: these labels get about four characters between two
     * swatches, and that is geometry rather than precision.
     */
    precision?: number | null;
  }>(),
  {
    sizeLabel: null,
    sizeExtent: null,
    colorLabel: null,
    colorExtent: null,
    ramp: () => [],
    pieLabel: null,
    pieTechs: () => [],
    selected: false,
    precision: null,
  },
);

/** How many technologies are named before the list says "and more". */
const MAX_TECHS = 8;

const shownTechs = computed(() => props.pieTechs.slice(0, MAX_TECHS));
const hiddenTechs = computed(() => Math.max(0, props.pieTechs.length - MAX_TECHS));

const showing = computed(
  () =>
    Boolean(props.sizeLabel) ||
    Boolean(props.colorLabel) ||
    Boolean(props.pieLabel) ||
    props.selected,
);

const span = (extent: [number, number] | null | undefined) =>
  extent
    ? [
        formatCompact(extent[0], props.precision),
        formatCompact(extent[1], props.precision),
      ]
    : null;
</script>

<template>
  <!-- No shadow: it has a hairline and is pinned to a corner of the map, so it
       is part of the figure rather than a surface floating over it. -->
  <div
    v-if="showing"
    class="pointer-events-none absolute bottom-2 left-2 z-raised flex max-w-52 flex-col gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5"
    data-testid="map-legend"
  >
    <!-- The size swatches and the selection ring are circles because they are
         the node marker itself, drawn small; the pie swatches below are squares
         because each keys a *series* — a technology — which is the mark the
         chart legends use for one (`legend.icon` in `charts/theme.ts`). -->
    <div v-if="props.sizeLabel" class="flex flex-col gap-0.5">
      <span class="truncate text-sm text-text-dim">Size · {{ props.sizeLabel }}</span>
      <div class="flex items-center gap-1.5">
        <!-- `bg-primary`, not `bg-accent`: shadcn's "accent" is the hover wash,
             `--cg-hover`, not the brand colour — the trap ui/toggle documents.
             These two dots are the size ramp, and on `bg-surface` they were a
             barely-visible grey rather than the accent every other saturated
             mark in the app uses. -->
        <span class="size-1.5 shrink-0 rounded-full bg-primary" />
        <span class="size-3 shrink-0 rounded-full bg-primary" />
        <span v-if="span(props.sizeExtent)" class="truncate text-sm text-text-muted">
          {{ span(props.sizeExtent)![0] }} – {{ span(props.sizeExtent)![1] }}
        </span>
      </div>
    </div>

    <div v-if="props.colorLabel" class="flex flex-col gap-0.5">
      <span class="truncate text-sm text-text-dim">
        Colour · {{ props.colorLabel }}
      </span>
      <div class="flex h-2 overflow-hidden rounded-xs">
        <span
          v-for="(step, index) in props.ramp"
          :key="index"
          class="h-full w-4"
          :style="{ backgroundColor: step }"
        />
      </div>
      <div
        v-if="span(props.colorExtent)"
        class="flex justify-between text-sm text-text-muted"
      >
        <span>{{ span(props.colorExtent)![0] }}</span>
        <span>{{ span(props.colorExtent)![1] }}</span>
      </div>
    </div>

    <div v-if="props.pieLabel" class="flex flex-col gap-0.5">
      <span class="truncate text-sm text-text-dim">Pie · {{ props.pieLabel }}</span>
      <div class="flex flex-col gap-0.5">
        <span
          v-for="tech in shownTechs"
          :key="tech.key"
          class="flex items-center gap-1.5 text-sm text-text-muted"
        >
          <span
            class="size-2 shrink-0 rounded-xs"
            :style="{ backgroundColor: tech.color }"
          />
          <span class="truncate">{{ tech.label }}</span>
        </span>
        <span v-if="hiddenTechs" class="text-sm text-text-muted">
          +{{ hiddenTechs }} more
        </span>
      </div>
    </div>

    <!-- `border-foreground` is `--cg-text`, the ring `ModelMap.layerPaint` draws
         around a selected node: near-black in the light theme, near-white in
         the dark, so it stays legible over a dimmed basemap. -->
    <div v-if="props.selected" class="flex items-center gap-1.5" data-testid="map-legend-selected">
      <span class="size-3 shrink-0 rounded-full border-2 border-foreground bg-primary" />
      <span class="truncate text-sm text-text-dim">Selected</span>
    </div>
  </div>
</template>
