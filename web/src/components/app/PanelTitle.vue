<script setup lang="ts">
/**
 * The label in a panel header. Truncates rather than wrapping — a header has a
 * fixed height, and a long variable name must not push the controls off the row.
 */
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <span
    :class="cn('min-w-0 truncate text-sm font-medium text-foreground', props.class)"
  >
    <slot />
  </span>
</template>
