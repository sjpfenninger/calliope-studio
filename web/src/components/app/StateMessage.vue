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
    variant?: "inline" | "block" | "fill" | "note";
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
  muted: "text-text-muted",
  danger: "text-danger-text",
  warning: "text-warning-text",
} as const;

const LAYOUT = {
  inline: "flex items-center gap-1.5 p-3 text-sm",
  // A note under a heading, in a sidebar or a dialog: `inline` without the
  // padding a list row needs. Nine call sites had gone around the component to
  // get this, and every one of them came back a size smaller and a tone fainter.
  note: "flex items-center gap-1.5 text-sm",
  // `content-center` is what makes these centre as a block. `place-items-center`
  // is `align-items`/`justify-items`, which centre each child inside its own row
  // and say nothing about the rows; a grid's `align-content` defaults to stretch,
  // so given a definite height the implicit rows divide it between them. A title
  // and its sentence therefore sat a quarter and three quarters of the way down a
  // full-height pane — the declared `gap-1.5` applied and invisible, because track
  // stretch was setting the distance — and an icon above them made it thirds.
  //
  // Not `place-content-center`: that also sets `justify-content`, shrinking the
  // single column track to fit-content, which moves where a long message wraps and
  // narrows a left-aligned child. `align-content` is the only axis at fault.
  //
  // `block` is content-height at every call site and so unaffected today. It
  // carries the class so that "centres in flow" stays true under a parent that
  // does give it a height — a flex row's default `stretch`, or a `flex-1`.
  block: "grid content-center place-items-center gap-1.5 p-6 text-center text-sm",
  fill: "grid h-full w-full content-center place-items-center gap-1.5 p-6 text-center text-sm",
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
