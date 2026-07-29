<script setup lang="ts">
/**
 * The filter strip above an explorer tree.
 *
 * A strip of its own rather than a control in the section's existing header:
 * the sidebar is a fifth of the window, so a field wedged between "Validate"
 * and two icon buttons has about eighty pixels to type into. It also makes Model
 * and Files look the same, which they should, since the control does the same
 * thing in both.
 *
 * It has to stay a *sibling* of the tree and never a descendant. Reka's
 * `TreeRoot` runs its typeahead on every keydown inside the `role="tree"`
 * element, so a field placed within one would move the selection on every letter
 * typed into it.
 */
import { Search, X } from "@lucide/vue";

import PanelHeader from "@/components/app/PanelHeader.vue";
import { FIELD, ICON_BUTTON_SM } from "@/lib/formClasses";
import { cn } from "@/lib/utils";

defineProps<{
  /** Names the field for a screen reader; there is no visible label. */
  label: string;
  placeholder: string;
  testid: string;
}>();

const query = defineModel<string>({ required: true });
</script>

<template>
  <PanelHeader>
    <div class="relative min-w-0 flex-1">
      <Search
        class="pointer-events-none absolute left-1.5 top-1/2 size-3.5 -translate-y-1/2 text-text-faint"
      />
      <!-- `text`, not `search`: the native type draws a clear button of its own,
           unstyleable and beside ours, and swallows Escape before we see it. -->
      <input
        v-model="query"
        type="text"
        autocomplete="off"
        spellcheck="false"
        :aria-label="label"
        :placeholder="placeholder"
        :data-testid="testid"
        :class="cn(FIELD, 'pl-6 pr-6')"
        @keydown.esc.prevent.stop="query = ''"
      />
      <button
        v-if="query"
        type="button"
        aria-label="Clear the filter"
        :class="cn(ICON_BUTTON_SM, 'absolute right-0.5 top-1/2 -translate-y-1/2')"
        @click="query = ''"
      >
        <X class="size-3" />
      </button>
    </div>
  </PanelHeader>
</template>
