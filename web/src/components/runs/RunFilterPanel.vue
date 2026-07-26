<script setup lang="ts">
/**
 * What the charts in this run tab are filtered to.
 *
 * Moved from `components/results/FilterSidebar.vue` with one substantive change:
 * it reaches its state through `inject` rather than a singleton store, because
 * two run tabs must not share filters. That injection carries *which* store, not
 * the state itself — the state is still in Pinia.
 *
 * Rewritten in shadcn-vue here rather than in the later removal pass: the
 * component was being moved anyway, and converting it twice would have been
 * pure waste.
 */
import { computed, inject } from "vue";

import { Checkbox } from "@/components/ui/checkbox";
import { MultiSelect } from "@/components/ui/multi-select";
import { RUN_SELECTION } from "@/stores/runSelection";

const store = inject(RUN_SELECTION)!;

/**
 * Above this many members a dimension gets a searchable multi-select rather
 * than a checkbox list: a hundred nodes as checkboxes is unusable.
 */
const CHECKBOX_LIMIT = 8;

const members = computed(() => store.catalog?.dimensions ?? {});

function isShort(dimension: string) {
  return (members.value[dimension]?.length ?? 0) <= CHECKBOX_LIMIT;
}

function toggle(dimension: string, member: string, checked: boolean) {
  const current = new Set(store.selected[dimension] ?? []);
  if (checked) current.add(member);
  else current.delete(member);
  store.setSelected(
    dimension,
    (members.value[dimension] ?? []).filter((name) => current.has(name)),
  );
}
</script>

<template>
  <aside
    data-testid="run-filters"
    class="flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-border bg-panel p-2"
  >
    <section
      v-for="dimension in store.dimensions"
      :key="dimension"
      :data-testid="`filter-${dimension}`"
    >
      <header class="mb-1 flex h-5 items-center gap-1">
        <span
          class="text-2xs font-semibold uppercase tracking-wide text-text-faint"
        >
          {{ dimension }}
        </span>
        <div class="flex-1" />
        <button
          type="button"
          class="rounded-xs px-1 text-2xs text-text-faint hover:bg-hover hover:text-foreground"
          @click="store.selectAll(dimension)"
        >
          All
        </button>
        <button
          type="button"
          class="rounded-xs px-1 text-2xs text-text-faint hover:bg-hover hover:text-foreground"
          @click="store.selectNone(dimension)"
        >
          None
        </button>
      </header>

      <div v-if="isShort(dimension)" class="flex flex-col">
        <!-- The row is the click target, not the box: a `<label>` wrapping the
             box would not forward to it, because Reka renders a button rather
             than an input. The box itself is therefore inert. -->
        <div
          v-for="member in members[dimension]"
          :key="member"
          role="checkbox"
          tabindex="0"
          :aria-checked="(store.selected[dimension] ?? []).includes(member)"
          :data-testid="`filter-${dimension}-${member}`"
          class="flex h-6 cursor-pointer items-center gap-1.5 rounded-xs px-1 text-sm hover:bg-hover"
          @click="
            toggle(
              dimension,
              member,
              !(store.selected[dimension] ?? []).includes(member),
            )
          "
          @keydown.space.prevent="
            toggle(
              dimension,
              member,
              !(store.selected[dimension] ?? []).includes(member),
            )
          "
        >
          <Checkbox
            class="pointer-events-none size-3.5"
            :model-value="(store.selected[dimension] ?? []).includes(member)"
          />
          <span class="truncate">{{ member }}</span>
        </div>
      </div>

      <MultiSelect
        v-else
        :model-value="store.selected[dimension] ?? []"
        :options="members[dimension] ?? []"
        :placeholder="`All ${dimension}`"
        @update:model-value="(value) => store.setSelected(dimension, value)"
      />
    </section>
  </aside>
</template>
