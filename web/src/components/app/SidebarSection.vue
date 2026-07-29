<script setup lang="ts">
/**
 * A titled group in the results sidebar, with its actions on the right.
 *
 * The three panels that make up that sidebar — filters, units, rounding — each
 * wrote `mb-1 flex h-5 items-center gap-1` for the header row, a raw
 * `SECTION_HEADING` span for the title, a `flex-1` spacer, and then between one
 * and two micro text buttons. The button's class string was the single
 * most-repeated literal in the tree, at four copies.
 *
 * `Eyebrow` carries the title, so the heading has one definition rather than a
 * fourth re-typing of the constant it wraps. Its own bottom margin is dropped
 * here: the header row already has one, and two would double the gap.
 */
import Eyebrow from "./Eyebrow.vue";

defineProps<{ title: string }>();
</script>

<template>
  <section>
    <header class="mb-1 flex h-5 items-center gap-1">
      <Eyebrow class="mb-0">{{ title }}</Eyebrow>
      <div class="flex-1" />
      <slot name="actions" />
    </header>
    <slot />
  </section>
</template>
