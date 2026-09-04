<script setup lang="ts">
/**
 * One block of the Math tab's left rail: a heading and what sits under it.
 *
 * The files panel and the source filter drew this strip with the same class
 * string in two files, byte for byte. Either would have drifted from the other
 * on the first edit, and a rail whose sections are at two densities is what
 * that looks like — so the geometry lives here and both take it.
 *
 * Attributes fall through to the root, so a caller's `data-testid` and `v-if`
 * land where they always did.
 */
</script>

<template>
  <div class="flex flex-col gap-1 border-b border-border-subtle px-2 py-1.5">
    <slot />
  </div>
</template>
