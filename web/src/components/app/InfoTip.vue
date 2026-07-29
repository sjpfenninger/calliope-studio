<script setup lang="ts">
/**
 * A tooltip on something that is not a button.
 *
 * This and `TooltipButton` are now the *only* way the app explains a control.
 * The alternative was fifty native `title=` attributes, which have OS styling, a
 * ~1s delay, no dark-mode awareness, and never appear on touch or on keyboard
 * focus — and which render `\n` inconsistently across platforms, which matters
 * for the one that lists a run's external files. Two mechanisms was worse than
 * either alone: along one row of controls, some explanations arrived at 300ms
 * and the rest a second later, which reads as broken rather than as two styles.
 *
 * A `title` on *truncated* text is the one exception and stays: that is the
 * browser's own overflow affordance, it needs the clipping measured to know
 * when to offer itself, and a portal per row would be absurd. The rule is
 * enforced — `design.test.ts`, `native-title` — and each surviving `title`
 * carries a pragma saying which visible string it is the unclipped form of.
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
