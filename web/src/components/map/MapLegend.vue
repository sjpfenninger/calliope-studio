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
    precision: null,
  },
);

/** How many technologies are named before the list says "and more". */
const MAX_TECHS = 8;

const shownTechs = computed(() => props.pieTechs.slice(0, MAX_TECHS));
const hiddenTechs = computed(() => Math.max(0, props.pieTechs.length - MAX_TECHS));

const showing = computed(
  () => Boolean(props.sizeLabel) || Boolean(props.colorLabel) || Boolean(props.pieLabel),
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
  <div
    v-if="showing"
    class="pointer-events-none absolute bottom-2 left-2 z-raised flex max-w-52 flex-col gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5 shadow-md"
    data-testid="map-legend"
  >
    <div v-if="props.sizeLabel" class="flex flex-col gap-0.5">
      <span class="truncate text-2xs text-text-muted">Size · {{ props.sizeLabel }}</span>
      <div class="flex items-center gap-1.5">
        <!-- `bg-primary`, not `bg-accent`: shadcn's "accent" is the hover wash,
             `--cg-hover`, not the brand colour — the trap ui/toggle documents.
             These two dots are the size ramp, and on `bg-surface` they were a
             barely-visible grey rather than the accent every other saturated
             mark in the app uses. -->
        <span class="size-1.5 shrink-0 rounded-full bg-primary" />
        <span class="size-3 shrink-0 rounded-full bg-primary" />
        <span v-if="span(props.sizeExtent)" class="truncate text-2xs text-text-faint">
          {{ span(props.sizeExtent)![0] }} – {{ span(props.sizeExtent)![1] }}
        </span>
      </div>
    </div>

    <div v-if="props.colorLabel" class="flex flex-col gap-0.5">
      <span class="truncate text-2xs text-text-muted">
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
        class="flex justify-between text-2xs text-text-faint"
      >
        <span>{{ span(props.colorExtent)![0] }}</span>
        <span>{{ span(props.colorExtent)![1] }}</span>
      </div>
    </div>

    <div v-if="props.pieLabel" class="flex flex-col gap-0.5">
      <span class="truncate text-2xs text-text-muted">Pie · {{ props.pieLabel }}</span>
      <div class="flex flex-col gap-0.5">
        <span
          v-for="tech in shownTechs"
          :key="tech.key"
          class="flex items-center gap-1.5 text-2xs text-text-faint"
        >
          <span
            class="size-2 shrink-0 rounded-xs"
            :style="{ backgroundColor: tech.color }"
          />
          <span class="truncate">{{ tech.label }}</span>
        </span>
        <span v-if="hiddenTechs" class="text-2xs text-text-faint">
          +{{ hiddenTechs }} more
        </span>
      </div>
    </div>
  </div>
</template>
