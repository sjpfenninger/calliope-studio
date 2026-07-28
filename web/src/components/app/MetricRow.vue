<script setup lang="ts">
/**
 * A row of `Metric`s divided by hairlines — a results summary strip.
 *
 * The divider is on the children rather than the container so the row wraps
 * cleanly on a narrow pane without leaving a rule hanging at the end of a line.
 */
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div
    :class="
      cn(
        'flex flex-wrap items-center gap-x-4 gap-y-2 px-2 py-1.5 [&>*]:border-l [&>*]:border-border-subtle [&>*]:pl-4 [&>*:first-child]:border-l-0 [&>*:first-child]:pl-0',
        props.class,
      )
    "
  >
    <slot />
  </div>
</template>
