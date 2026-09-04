<script setup lang="ts" generic="T extends Record<string, any>">
/**
 * A dense, indented tree.
 *
 * shadcn-vue has no tree, so this is written directly on Reka UI's
 * `TreeRoot`/`TreeItem`. Hand-rolling a recursive component instead would mean
 * hand-rolling arrow-key navigation, typeahead, expand/collapse state and the
 * ARIA roles — all of which both explorer trees need and none of which is worth
 * writing twice.
 *
 * Reka's tree primitive is newer than the rest of the library, so both call
 * sites go through the `ModelTree`/`FileTree` wrappers rather than using this
 * directly: if it has to be replaced, that is two files rather than two screens.
 *
 * The row is 24px with a 2px indent guide per level. Selection is a soft accent
 * wash rather than a filled bar — a file tree is scanned far more often than it
 * is chosen from, so the selected row should not dominate.
 */
import { TreeItem, TreeRoot } from "reka-ui";
import { ChevronRight } from "@lucide/vue";
import type { Component } from "vue";

import { ICON_STROKE_WIDTH_TIGHT } from "@/lib/icons";
import { cn } from "@/lib/utils";

const props = defineProps<{
  items: T[];
  /** Stable identity for an item; also what `modelValue` holds. */
  getKey: (item: T) => string;
  getChildren?: (item: T) => T[] | undefined;
  /** What to show on a row. Falls back to the key. */
  getLabel?: (item: T) => string;
  /** Per-item icon, drawn before the label. */
  getIcon?: (item: T) => Component | undefined;
  class?: string;
}>();

const modelValue = defineModel<T | undefined>();
const expanded = defineModel<string[]>("expanded", { default: () => [] });

/**
 * A row was chosen, with the event that chose it.
 *
 * Callers used to watch `modelValue` instead, which loses two things: the
 * modifier keys — so Cmd-click could not mean "open in a new tab" — and any
 * click on the row that is *already* selected, so re-opening a file whose tab
 * you had just closed did nothing at all.
 *
 * Reka dispatches its own `select` for both a click and Enter/Space, carrying
 * the originating event in `detail`, so this covers the keyboard too — and it
 * matches the key without `exact`, so Shift+Enter and Cmd+Enter arrive with
 * their modifiers intact, which is what `lib/openIntent` reads to open a tab
 * that stays from the keyboard.
 */
const emit = defineEmits<{
  select: [item: T, event: MouseEvent | KeyboardEvent];
}>();

type TreeSelectEvent = CustomEvent<{ originalEvent: MouseEvent | KeyboardEvent }>;

function onSelect(item: T, event: TreeSelectEvent) {
  // Not prevented: Reka skips its own selection for a defaulted event, and the
  // selected row is what both trees highlight.
  emit("select", item, event.detail.originalEvent);
}
</script>

<template>
  <TreeRoot
    v-slot="{ flattenItems }"
    v-model="modelValue"
    v-model:expanded="expanded"
    :items="items"
    :get-key="getKey"
    :get-children="getChildren"
    selection-behavior="replace"
    :class="cn('select-none overflow-auto py-1 text-sm', props.class)"
  >
    <!-- Reka counts levels from 1, so `level * step` would leave every root
         indented from nothing. -->
    <TreeItem
      v-for="item in flattenItems"
      :key="item._id"
      v-bind="item.bind"
      :style="{ paddingLeft: `${(item.level - 1) * 12}px` }"
      class="group relative flex h-6 w-full items-center gap-1 rounded-sm pr-2 text-text-dim transition-colors hover:bg-hover hover:text-foreground focus-visible:bg-hover data-[selected]:bg-accent-soft data-[selected]:text-accent-text data-[selected]:font-medium"
      @select="onSelect(item.value, $event as TreeSelectEvent)"
    >
      <!-- A fixed slot whether or not the row has children, so labels at the
           same level line up rather than shifting by the chevron's width. -->
      <span class="grid size-4 shrink-0 place-items-center">
        <ChevronRight
          v-if="item.hasChildren"
          :stroke-width="ICON_STROKE_WIDTH_TIGHT"
          class="size-3 text-text-faint transition-transform duration-fast group-data-[expanded]:rotate-90"
        />
      </span>

      <component
        :is="getIcon(item.value)"
        v-if="getIcon?.(item.value)"
        class="size-3.5 shrink-0 text-text-faint group-data-[selected]:text-accent-text"
      />

      <span class="truncate">
        {{ getLabel ? getLabel(item.value) : getKey(item.value) }}
      </span>

      <!-- Anything a caller wants at the right-hand end: a badge, a dirty dot. -->
      <slot name="trailing" :item="item.value" :level="item.level" />
    </TreeItem>
  </TreeRoot>
</template>
