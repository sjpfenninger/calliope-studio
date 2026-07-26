<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { Plus, Trash2 } from "lucide-vue-next";

import client from "@/api/client";
import EditorToolbar from "./EditorToolbar.vue";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  DANGER_ICON_BUTTON,
  FIELD,
  FIELD_LABEL,
  GHOST_BUTTON,
} from "@/lib/formClasses";
import { ICON_STROKE_WIDTH } from "@/lib/icons";
import { useTabsStore } from "@/stores/tabs";
import { useSchemaStore } from "@/stores/schema";
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
// SchemaObjectEditor takes care of the comma-separated and key/value shapes.
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
// rows/columns: the schema says string | string[] | null, so one comma-joined field.
// add_dims/select: the schema is a {key: val} mapping, so a list of key/value rows.
// drop / rename_dims: hidden for now (uncommon).
// ---------------------------------------------------------------------------

const dataTableOverlay: FieldOverlay = {
  rows: { widget: "commaSeparated", label: "rows (comma-separated dims)" },
  columns: { widget: "commaSeparated", label: "columns (comma-separated dims)" },
  add_dims: { widget: "keyValue" },
  select: { widget: "keyValue" },
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
  <div class="flex min-h-0 flex-1 flex-col">
    <p v-if="isLoading" class="p-6 text-center text-sm text-muted-foreground">
      Loading data_tables…
    </p>
    <p v-else-if="error" class="p-6 text-center text-sm text-danger-text">{{ error }}</p>

    <template v-else>
      <EditorToolbar :saving="isSaving" @save="save">
        <button type="button" :class="GHOST_BUTTON" @click="addEntry">
          <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
          Add table
        </button>
      </EditorToolbar>

      <div class="min-h-0 flex-1 overflow-auto">
        <p v-if="!entries.length" class="p-6 text-center text-sm text-muted-foreground">
          No data tables defined yet.
        </p>

        <Accordion
          v-else
          type="multiple"
          :default-value="entries.map((_, i) => String(i))"
          class="px-2"
        >
          <AccordionItem v-for="(entry, i) in entries" :key="i" :value="String(i)">
            <div class="flex items-center gap-1">
              <AccordionTrigger
                class="min-w-0 flex-1 items-center py-1.5 font-mono text-sm hover:no-underline"
              >
                {{ entry.name || "(unnamed)" }}
              </AccordionTrigger>
              <button
                type="button"
                title="Remove this table"
                :class="DANGER_ICON_BUTTON"
                @click.stop="removeEntry(i)"
              >
                <Trash2 class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
              </button>
            </div>
            <AccordionContent>
              <div class="flex flex-col gap-2 pb-2">
                <!-- name is the mapping key, not a schema property. -->
                <div class="flex flex-col gap-1">
                  <label :class="FIELD_LABEL">name</label>
                  <input
                    v-model="entry.name"
                    type="text"
                    :class="FIELD"
                    @input="onNameChange"
                  />
                </div>
                <SchemaObjectEditor
                  :key="filePath + ':dt:' + i"
                  :schema="entrySchema"
                  :model-value="entry.data"
                  :overlay="dataTableOverlay"
                  @update:model-value="onEntryDataChange(i, $event)"
                />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </template>
  </div>
</template>
