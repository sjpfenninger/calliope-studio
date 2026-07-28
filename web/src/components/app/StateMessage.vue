<script setup lang="ts">
/**
 * Empty, loading and error, in one place.
 *
 * There were roughly twenty-eight copies of four layouts — `p-6 text-center`,
 * a bare `p-3`, a `grid place-items-center`, and no wrapper at all — plus one
 * dashed box that was the only dashed border in the app, and two `<style scoped>`
 * blocks whose font sizes (`0.85rem`, `0.8rem`) exist in no type scale.
 *
 * Loading always names what is loading. "Loading…" tells the user nothing they
 * could not see; "Reading results…" tells them which of the three things a run
 * pane is waiting for.
 *
 * `fill` deliberately does not position itself. Some callers want it absolutely
 * placed over a canvas, some want it in flow — baking in `absolute inset-0` would
 * have forced a fourth variant for the other case.
 */
import { computed, type Component, type HTMLAttributes } from "vue";
import { Loader2, TriangleAlert } from "@lucide/vue";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    /** `inline` sits in a list; `block` centres in flow; `fill` fills its parent. */
    variant?: "inline" | "block" | "fill";
    tone?: "muted" | "danger" | "warning";
    loading?: boolean;
    /** Drawn above the message. Ignored while loading, which has its own. */
    icon?: Component;
    /** A stronger first line, with the slot as the explanation beneath. */
    title?: string;
    class?: HTMLAttributes["class"];
  }>(),
  { variant: "block", tone: "muted", loading: false },
);

const TONE = {
  muted: "text-muted-foreground",
  danger: "text-danger-text",
  warning: "text-warning-text",
} as const;

const LAYOUT = {
  inline: "flex items-center gap-1.5 p-3 text-sm",
  block: "grid place-items-center gap-1.5 p-6 text-center text-sm",
  fill: "grid h-full w-full place-items-center gap-1.5 p-6 text-center text-sm",
} as const;

const classes = computed(() =>
  cn(LAYOUT[props.variant], TONE[props.tone], props.class),
);

const glyph = computed(() =>
  props.loading ? Loader2 : props.tone === "muted" ? props.icon : TriangleAlert,
);
</script>

<template>
  <div :class="classes">
    <component
      :is="glyph"
      v-if="glyph"
      class="size-3.5 shrink-0"
      :class="loading && 'animate-spin'"
    />
    <p v-if="title" class="font-medium">{{ title }}</p>
    <p v-if="$slots.default"><slot /></p>
    <slot name="action" />
  </div>
</template>
