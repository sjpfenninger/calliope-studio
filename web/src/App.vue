<script setup lang="ts">
/**
 * The shell provides its own chrome, so this is only a mount point.
 *
 * There is no global menubar any more: the wordmark and model name moved into
 * the sidebar header, and the single "Results" link became the Runs section.
 */
import { setLucideProps } from "@lucide/vue";
import TooltipProvider from "./components/ui/tooltip/TooltipProvider.vue";
import { ICON_STROKE_WIDTH } from "./lib/icons";
import { useUiStore } from "./stores/ui";

// Constructed here so the theme attribute is written before anything paints.
useUiStore();

// One stroke width for every lucide icon in the app, including the ones shadcn's
// own components render, which is what lets the ~60 per-icon `:stroke-width`
// bindings go away. It is a `provide`, so it reaches teleported content too:
// Vue's injection follows the component tree, not the DOM.
//
// Size is deliberately left out. A Tailwind `size-*` utility sets CSS width and
// height, which beat lucide's SVG attributes, and every icon here carries one.
setLucideProps({ strokeWidth: ICON_STROKE_WIDTH });
</script>

<template>
  <!-- The copied-in provider defaults to `delayDuration: 0`, which flashes a
       tooltip on every incidental hover across a dense toolbar. -->
  <TooltipProvider :delay-duration="300" :skip-delay-duration="200">
    <RouterView />
  </TooltipProvider>
</template>
