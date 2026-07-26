<script setup lang="ts">
/**
 * The shell provides its own chrome, so this is only a mount point.
 *
 * There is no global menubar any more: the wordmark and model name moved into
 * the sidebar header, and the single "Results" link became the Runs section.
 */
import { useUiStore } from "./stores/ui";

// Constructed here so the theme attribute is written before anything paints.
useUiStore();
</script>

<template>
  <RouterView />
</template>
