<script setup lang="ts">
/**
 * The 24px strip at the bottom of a pane: counts, sizes, a retention picker.
 *
 * One height, where there were two (24 and 32). Text is `text-2xs` because a
 * footer is chrome rather than content — this is one of the few places the micro
 * step is still the right answer.
 */
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div
    :class="
      cn(
        'flex h-6 shrink-0 items-center gap-1.5 border-t border-border px-2 text-2xs text-text-muted',
        props.class,
      )
    "
  >
    <slot />
  </div>
</template>
