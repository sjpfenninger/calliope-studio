<script setup lang="ts">
/**
 * A tooltip on something that is not a button.
 *
 * The app carried fifty native `title=` attributes while the styled tooltip
 * primitive went unused. Native titles have OS styling, a ~1s delay, no
 * dark-mode awareness, and never appear on touch — and they render `\n`
 * inconsistently across platforms, which matters for the one that lists a run's
 * external files.
 *
 * A `title` on *truncated* text is a different thing and stays: that is the
 * browser's own overflow affordance, and a portal per row would be absurd.
 *
 * An empty `label` passes the slot straight through with no tooltip at all, so a
 * caller whose explanation is conditional — a control that is only sometimes
 * disabled, and only sometimes has a reason to give — can bind the label and stop
 * there, rather than branching around this component and rendering its child
 * twice.
 */
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

withDefaults(
  defineProps<{
    label: string;
    side?: "top" | "right" | "bottom" | "left";
  }>(),
  { side: "top" },
);
</script>

<template>
  <Tooltip v-if="label">
    <TooltipTrigger as-child>
      <slot />
    </TooltipTrigger>
    <TooltipContent :side="side" class="whitespace-pre-line">
      {{ label }}
    </TooltipContent>
  </Tooltip>
  <slot v-else />
</template>
