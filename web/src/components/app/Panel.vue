<script setup lang="ts">
/**
 * A bordered box on the content surface.
 *
 * `rounded-md` (4px) rather than the `rounded-sm` the hand-rolled sections used:
 * 3px is the *control* step, 4px is the container step, and the two were being
 * chosen by author rather than by what the element is. `formClasses.SECTION`
 * moved with it, so a form section and a figure card agree.
 */
import { computed, type HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    /** `plain` drops the border and fill, for a group that only needs the layout. */
    tone?: "card" | "plain";
    class?: HTMLAttributes["class"];
  }>(),
  { tone: "card" },
);

const classes = computed(() =>
  cn(
    "flex min-h-0 flex-col",
    props.tone === "card" && "rounded-md border border-border bg-surface",
    props.class,
  ),
);
</script>

<template>
  <div :class="classes">
    <slot />
  </div>
</template>
