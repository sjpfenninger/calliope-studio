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
import { inject } from "vue";
import SidebarSection from "@/components/app/SidebarSection.vue";
import { TEXT_BUTTON_SM } from "@/lib/formClasses";

import { Checkbox } from "@/components/ui/checkbox";
import { MultiSelect } from "@/components/ui/multi-select";
import { RUN_SELECTION, type FilterSection } from "@/stores/runSelection";
import RunRoundingPanel from "./RunRoundingPanel.vue";
import RunUnitsPanel from "./RunUnitsPanel.vue";

const store = inject(RUN_SELECTION)!;

/**
 * Above this many members a section gets a searchable multi-select rather
 * than a checkbox list: a hundred nodes as checkboxes is unusable.
 */
const CHECKBOX_LIMIT = 8;

/**
 * The panel is generic over `store.sections` and knows nothing about what any of
 * them mean — supply and transmission are sections like any other, which is what
 * keeps the knowledge of which technologies are which in one place in the store.
 *
 * That is also why splitting the technologies by base tech needed nothing here
 * beyond the `data-dimension` attribute: a section already carries All/None, and
 * `selectAll`/`selectNone` are already keyed by section name.
 */
function isChecked(section: FilterSection, member: string) {
  return (store.selected[section.name] ?? []).includes(member);
}

function toggle(section: FilterSection, member: string, checked: boolean) {
  const current = new Set(store.selected[section.name] ?? []);
  if (checked) current.add(member);
  else current.delete(member);
  store.setSelected(
    section.name,
    section.members.filter((name) => current.has(name)),
  );
}
</script>

<template>
  <aside
    data-testid="run-filters"
    class="flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-border bg-panel p-2"
  >
    <SidebarSection
      v-for="section in store.sections"
      :key="section.name"
      :title="section.name"
      :data-testid="`filter-${section.name}`"
      :data-dimension="section.dimension"
    >
      <template #actions>
        <button
          type="button"
          :class="TEXT_BUTTON_SM"
          @click="store.selectAll(section.name)"
        >
          All
        </button>
        <button
          type="button"
          :class="TEXT_BUTTON_SM"
          @click="store.selectNone(section.name)"
        >
          None
        </button>
      </template>

      <div
        v-if="section.members.length <= CHECKBOX_LIMIT"
        class="flex flex-col"
      >
        <!-- The row is the click target, not the box: a `<label>` wrapping the
             box would not forward to it, because Reka renders a button rather
             than an input. The box itself is therefore inert. -->
        <!-- The testid stays keyed on the raw member, never on its label, so it
             holds no arrow and stays stable if the labelling changes. -->
        <!-- design-check: allow native-title — the member's own name, which
             truncates in a sidebar this narrow. One row, many of them. -->
        <div
          v-for="member in section.members"
          :key="member"
          role="checkbox"
          tabindex="0"
          :aria-checked="isChecked(section, member)"
          :data-testid="`filter-${section.name}-${member}`"
          :title="member"
          class="flex h-6 cursor-pointer items-center gap-1.5 rounded-xs px-1 text-sm hover:bg-hover"
          @click="toggle(section, member, !isChecked(section, member))"
          @keydown.space.prevent="
            toggle(section, member, !isChecked(section, member))
          "
        >
          <Checkbox
            class="pointer-events-none size-3.5"
            :model-value="isChecked(section, member)"
          />
          <span class="truncate">{{ section.labels[member] ?? member }}</span>
        </div>
      </div>

      <MultiSelect
        v-else
        :model-value="store.selected[section.name] ?? []"
        :options="section.members"
        :labels="section.labels"
        :placeholder="`No ${section.name} selected`"
        @update:model-value="(value) => store.setSelected(section.name, value)"
      />
    </SidebarSection>

    <!-- Last, and after the filters it is not one of: what a figure is narrowed
         to is asked far more often than what it is measured in, and a setting
         that is right once should not sit above the controls used every time. -->
    <RunUnitsPanel />
    <!-- Below the units, because "what is this measured in" comes before "how
         much of it do I want to read", and because a model with no settable
         quantity renders no units section at all. -->
    <RunRoundingPanel />
  </aside>
</template>
