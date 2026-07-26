<script setup lang="ts">
import { computed } from "vue";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import MultiSelect from "primevue/multiselect";
import { useSelectionStore } from "../../stores/selection";

const store = useSelectionStore();

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
  <aside class="filters">
    <section v-for="dimension in store.dimensions" :key="dimension" class="group">
      <header>
        <span class="label">{{ dimension }}</span>
        <span class="actions">
          <Button
            text
            size="small"
            label="All"
            @click="store.selectAll(dimension)"
          />
          <Button
            text
            size="small"
            label="None"
            @click="store.selectNone(dimension)"
          />
        </span>
      </header>

      <div v-if="isShort(dimension)" class="checkboxes">
        <label v-for="member in members[dimension]" :key="member" class="check">
          <Checkbox
            :model-value="(store.selected[dimension] ?? []).includes(member)"
            binary
            @update:model-value="(value) => toggle(dimension, member, !!value)"
          />
          <span>{{ member }}</span>
        </label>
      </div>

      <MultiSelect
        v-else
        :model-value="store.selected[dimension] ?? []"
        :options="members[dimension]"
        filter
        display="chip"
        :max-selected-labels="3"
        :placeholder="`All ${dimension}`"
        class="w-full"
        @update:model-value="(value) => store.setSelected(dimension, value)"
      />
    </section>
  </aside>
</template>

<style scoped>
.filters {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 0.75rem;
  overflow-y: auto;
}

.group header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.35rem;
}

.label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color, #888);
}

.actions {
  display: flex;
  gap: 0.15rem;
}

.checkboxes {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.check {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.85rem;
  cursor: pointer;
}

.w-full {
  width: 100%;
}
</style>
