<script setup lang="ts">
/**
 * One collapsible entry in a structured editor.
 *
 * Five editors repeated this markup — techs, nodes, links, overrides and data
 * tables — differing only in whether the outer gap was `gap-1` or `gap-1.5`.
 *
 * The `#meta` slot renders *inside* the trigger, which two of the five already
 * did and three did not; putting a badge outside the trigger means clicking it
 * does not toggle the row, which is a small trap with no upside.
 */
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Trash2 } from "@lucide/vue";
import TooltipButton from "../app/TooltipButton.vue";

defineProps<{
  /** The AccordionItem value; use `entryKey` so it stays stable. */
  value: string;
  /** The entry's name, shown monospace as the row's title. */
  name: string;
  /** Tooltip on the remove button, e.g. "Remove this technology". */
  removeLabel: string;
}>();

defineEmits<{ remove: [] }>();
</script>

<template>
  <AccordionItem :value="value">
    <div class="flex items-center gap-1.5">
      <AccordionTrigger class="min-w-0 flex-1 items-center gap-2 font-mono text-sm">
        <span class="truncate">{{ name }}</span>
        <slot name="meta" />
      </AccordionTrigger>
      <TooltipButton
        :label="removeLabel"
        :icon="Trash2"
        tone="danger"
        @click="$emit('remove')"
      />
    </div>
    <AccordionContent>
      <div class="flex flex-col gap-2 pb-2">
        <slot />
      </div>
    </AccordionContent>
  </AccordionItem>
</template>
