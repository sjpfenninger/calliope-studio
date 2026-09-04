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
 *
 * **Remove asks first.** An entry owns things — a technology its parameters, an
 * override its settings — and the row is where all five editors take one out,
 * so the question is asked here, once, in `removalRequest`'s words. `remove`
 * is emitted only on a yes.
 */
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Trash2 } from "@lucide/vue";
import TooltipButton from "../app/TooltipButton.vue";
import { removalRequest } from "@/composables/useSectionEditor";
import { useConfirmStore } from "@/stores/confirm";

const props = defineProps<{
  /** The AccordionItem value; use `rowKey` so it stays stable across a rename. */
  value: string;
  /** The entry's name, shown as the row's title. */
  name: string;
  /** Tooltip on the remove button, e.g. "Remove this technology". */
  removeLabel: string;
  /** What goes with the entry, for the confirmation: "12 parameters". */
  owns?: string;
  /**
   * The row's own testid, on the `AccordionItem` — so Reka's `data-state` and
   * the `data-name` below sit on the element a check selects, and open-versus-
   * collapsed is readable without a second selector.
   */
  testid?: string;
}>();

const emit = defineEmits<{ remove: [] }>();

const confirm = useConfirmStore();

async function remove(): Promise<void> {
  if (await confirm.ask(removalRequest(props.name, props.owns ?? ""))) emit("remove");
}
</script>

<template>
  <AccordionItem :value="value" :data-testid="testid" :data-name="name">
    <div class="flex items-center gap-1.5">
      <!-- No `py-1.5` and no `hover:no-underline`: AccordionTrigger is already
           `h-7` and has never underlined. All five copies carried both anyway,
           and the padding only squeezed the row's own content. -->
      <AccordionTrigger class="min-w-0 flex-1 items-center gap-2 text-sm">
        <span class="truncate">{{ name }}</span>
        <slot name="meta" />
      </AccordionTrigger>
      <TooltipButton
        :label="removeLabel"
        :icon="Trash2"
        tone="danger"
        size="xs"
        testid="entry-remove"
        @click="remove"
      />
    </div>
    <AccordionContent>
      <div class="flex flex-col gap-2 pb-2">
        <slot />
      </div>
    </AccordionContent>
  </AccordionItem>
</template>
