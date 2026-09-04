<script setup lang="ts">
/**
 * A 2px indeterminate accent sliver, for work whose progress is unknowable.
 *
 * Deliberately *not* a capacity meter. A run reports a stage, not a fraction,
 * and disk usage has no quota to divide by — a bar with no denominator is
 * decoration pretending to be data. This says only "something is happening",
 * which is the honest subset and the one that is actually needed: a refetching
 * figure keeps its old data on screen and needs somewhere to put the fact.
 *
 * Under `prefers-reduced-motion` the global rule stops the sliver after one
 * millisecond, parked at its resting third — which reads as a third done,
 * exactly the fraction this has no business claiming. `motion-reduce:w-full`
 * makes it a solid line instead: still "working", still no denominator.
 */
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{
  active?: boolean;
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <div
    v-if="props.active"
    role="progressbar"
    aria-label="Working"
    :class="cn('h-0.5 w-full shrink-0 overflow-hidden bg-transparent', props.class)"
  >
    <div
      class="h-full w-1/3 animate-[cg-sliver_1.1s_ease-in-out_infinite] bg-primary motion-reduce:w-full"
    />
  </div>
</template>
