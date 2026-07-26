<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import Accordion from "primevue/accordion";
import AccordionPanel from "primevue/accordionpanel";
import AccordionHeader from "primevue/accordionheader";
import AccordionContent from "primevue/accordioncontent";
import InputText from "primevue/inputtext";
import Button from "primevue/button";
import client from "../../api/client";
import { useTabsStore } from "../../stores/tabs";
import { useSchemaStore } from "../../stores/schema";
import SchemaObjectEditor, { type FieldOverlay } from "./SchemaObjectEditor.vue";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabId: string;
}>();

const tabsStore = useTabsStore();
const schemaStore = useSchemaStore();

const isLoading = ref(true);
const isSaving = ref(false);
const error = ref<string | null>(null);

// Each entry holds the table name (dict key) and the raw data object from YAML.
// SchemaObjectEditor takes care of CommaSeparated / KVPairs conversions.
interface DataTableEntry {
  name: string;
  data: Record<string, any>;
}

const entries = ref<DataTableEntry[]>([]);

// ---------------------------------------------------------------------------
// Per-entry schema — the CalliopeDataTable schema from the store.
// ---------------------------------------------------------------------------

const entrySchema = computed<Record<string, any>>(() => {
  if (!schemaStore.isLoaded) return {};
  const dtSchema = schemaStore.subschema("data_tables");
  if (!dtSchema?.patternProperties) return {};
  // The schema uses patternProperties; the first (and only) value is the entry schema.
  return (Object.values(dtSchema.patternProperties)[0] as Record<string, any>) ?? {};
});

// ---------------------------------------------------------------------------
// Overlay — curated field selection + widget hints.
// rows/columns: schema is string | string[] | null -> CommaSeparated widget.
// add_dims/select: schema is {key:val} dict (patternProperties) -> KVPairs widget.
// drop / rename_dims: hidden for now (uncommon).
// ---------------------------------------------------------------------------

const dataTableOverlay: FieldOverlay = {
  rows: { widget: "CommaSeparated", label: "rows (comma-separated dims)" },
  columns: { widget: "CommaSeparated", label: "columns (comma-separated dims)" },
  add_dims: { widget: "KVPairs" },
  select: { widget: "KVPairs" },
  drop: { hidden: true },
  rename_dims: { hidden: true },
};

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

async function load() {
  isLoading.value = true;
  error.value = null;
  try {
    const res = await client.get<{ section: string; data: any }>(
      `/api/versions/${props.versionId}/yaml-section/${props.filePath}?section=data_tables`
    );
    const d = res.data.data ?? {};
    entries.value = Object.entries(d).map(([name, raw]: [string, any]) => ({
      name,
      data: raw ?? {},
    }));
  } catch (e: any) {
    error.value =
      e?.response?.data?.detail ?? "Failed to load data_tables section.";
  } finally {
    isLoading.value = false;
  }
}

function buildPayload(): Record<string, any> {
  const result: Record<string, any> = {};
  for (const e of entries.value) {
    if (!e.name) continue;
    // Strip null values before saving; preserve everything else as-is.
    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(e.data)) {
      if (v !== null && v !== undefined) payload[k] = v;
    }
    result[e.name] = payload;
  }
  return result;
}

async function save() {
  isSaving.value = true;
  try {
    await client.put(
      `/api/versions/${props.versionId}/yaml-section/${props.filePath}?section=data_tables`,
      { data: buildPayload() }
    );
    tabsStore.markClean(props.tabId);
  } finally {
    isSaving.value = false;
  }
}

// ---------------------------------------------------------------------------
// Entry management
// ---------------------------------------------------------------------------

function addEntry() {
  entries.value.push({ name: "", data: {} });
  tabsStore.markDirty(props.tabId);
}

function removeEntry(i: number) {
  entries.value.splice(i, 1);
  tabsStore.markDirty(props.tabId);
}

function onNameChange() {
  tabsStore.markDirty(props.tabId);
}

function onEntryDataChange(i: number, data: Record<string, any>) {
  entries.value[i].data = data;
  tabsStore.markDirty(props.tabId);
}

// ---------------------------------------------------------------------------
// Keyboard shortcut
// ---------------------------------------------------------------------------

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    save();
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  await Promise.all([load(), schemaStore.load()]);
});

watch(() => props.filePath, load);
</script>

<template>
  <div class="dt-editor">
    <div v-if="isLoading" class="placeholder">Loading data_tables...</div>
    <div v-else-if="error" class="placeholder error">{{ error }}</div>
    <template v-else>
      <div class="toolbar">
        <Button label="Save" icon="pi pi-save" size="small" :loading="isSaving" @click="save" />
        <Button label="Add table" icon="pi pi-plus" size="small" severity="secondary" @click="addEntry" />
        <span class="hint">or Ctrl/Cmd+S</span>
      </div>

      <div v-if="entries.length === 0" class="placeholder">
        No data tables defined. Click "Add table" to create one.
      </div>

      <Accordion v-else :multiple="true" :value="entries.map((_, i) => String(i))">
        <AccordionPanel
          v-for="(entry, i) in entries"
          :key="i"
          :value="String(i)"
        >
          <AccordionHeader>
            <span class="entry-title">{{ entry.name || "(unnamed)" }}</span>
            <Button
              icon="pi pi-trash"
              size="small"
              severity="danger"
              text
              class="delete-btn"
              @click.stop="removeEntry(i)"
            />
          </AccordionHeader>
          <AccordionContent>
            <div class="entry-form">
              <!-- name is the dict key, not a schema property -->
              <div class="field">
                <label>name</label>
                <InputText
                  v-model="entry.name"
                  size="small"
                  class="w-full"
                  @input="onNameChange"
                />
              </div>
              <!-- All other fields driven by the CalliopeDataTable schema -->
              <SchemaObjectEditor
                :key="filePath + ':dt:' + i"
                :schema="entrySchema"
                :modelValue="entry.data"
                :overlay="dataTableOverlay"
                @update:modelValue="onEntryDataChange(i, $event)"
              />
            </div>
          </AccordionContent>
        </AccordionPanel>
      </Accordion>
    </template>
  </div>
</template>

<style scoped>
.dt-editor {
  display: flex;
  flex-direction: column;
  padding: 1rem;
  gap: 0.75rem;
  overflow: auto;
  height: 100%;
}

.placeholder {
  padding: 2rem;
  text-align: center;
  color: var(--p-text-muted-color, #888);
  font-size: 0.875rem;
}

.placeholder.error {
  color: #ef4444;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.hint {
  font-size: 0.75rem;
  color: var(--p-text-muted-color, #888);
}

.entry-title {
  font-family: monospace;
  font-size: 0.875rem;
  flex: 1;
}

.delete-btn {
  margin-left: auto;
}

.entry-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.field label {
  font-size: 0.8rem;
  font-family: monospace;
  color: var(--p-text-muted-color, #666);
}

.w-full {
  width: 100%;
}
</style>
