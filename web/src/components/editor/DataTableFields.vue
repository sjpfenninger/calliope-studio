<script setup lang="ts">
/**
 * The form for one `data_tables:` entry — its name and its schema fields.
 *
 * Its own component because the two views need it in different wrappers: the
 * overview puts it inside an accordion item, and a single table puts it in the
 * top half of a splitter above its CSV. Duplicating the markup meant the two
 * could drift, and the widget overlay below is the part that must not.
 */
import { computed } from "vue";

import FieldRow from "@/components/app/FieldRow.vue";
import { FIELD } from "@/lib/formClasses";
import { useSchemaStore } from "@/stores/schema";
import SchemaObjectEditor, { type FieldOverlay } from "./SchemaObjectEditor.vue";

const props = defineProps<{
  name: string;
  data: Record<string, any>;
  /** Distinguishes one entry's fields from another's when the list re-renders. */
  formKey: string;
}>();

const emit = defineEmits<{
  "update:name": [string];
  "update:data": [Record<string, any>];
}>();

const schemaStore = useSchemaStore();

// The CalliopeDataTable schema. It uses patternProperties; the first (and only)
// value is the per-entry schema.
const entrySchema = computed<Record<string, any>>(() => {
  if (!schemaStore.isLoaded) return {};
  const dtSchema = schemaStore.subschema("data_tables");
  if (!dtSchema?.patternProperties) return {};
  return (Object.values(dtSchema.patternProperties)[0] as Record<string, any>) ?? {};
});

/**
 * Curated field selection + widget hints.
 *
 * rows/columns: the schema says string | string[] | null, so one comma-joined
 * field. add_dims/select: a {key: val} mapping, so a list of key/value rows.
 * drop / rename_dims: hidden for now (uncommon).
 */
const dataTableOverlay: FieldOverlay = {
  rows: { widget: "commaSeparated", label: "rows (comma-separated dims)" },
  columns: { widget: "commaSeparated", label: "columns (comma-separated dims)" },
  add_dims: { widget: "keyValue" },
  select: { widget: "keyValue" },
  drop: { hidden: true },
  rename_dims: { hidden: true },
};
</script>

<template>
  <div class="flex flex-col gap-2 pb-2">
    <!-- name is the mapping key, not a schema property. -->
    <FieldRow label="name" width="short">
      <input
        :value="props.name"
        type="text"
        :class="FIELD"
        @input="emit('update:name', ($event.target as HTMLInputElement).value)"
      />
    </FieldRow>
    <SchemaObjectEditor
      :key="props.formKey"
      :schema="entrySchema"
      :model-value="props.data"
      :overlay="dataTableOverlay"
      @update:model-value="emit('update:data', $event)"
    />
  </div>
</template>
