<script setup lang="ts">
/**
 * The small-caps heading above a group of fields or filters.
 *
 * `formClasses.SECTION_HEADING` was re-typed verbatim in four files, each with a
 * different bottom margin. The margin is part of the thing.
 */
import type { HTMLAttributes } from "vue";
import { SECTION_HEADING } from "@/lib/formClasses";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <span :class="cn(SECTION_HEADING, 'mb-1', props.class)">
    <slot />
  </span>
</template>
