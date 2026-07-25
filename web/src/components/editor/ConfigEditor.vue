<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from "vue";
import InputText from "primevue/inputtext";
import Button from "primevue/button";
import client from "../../api/client";
import { useEditorStore } from "../../stores/editor";
import { useSchemaStore } from "../../stores/schema";
import SchemaObjectEditor, { type FieldOverlay } from "./SchemaObjectEditor.vue";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabKey: string;
}>();

const editorStore = useEditorStore();
const schemaStore = useSchemaStore();

const isLoading = ref(true);
const isSaving = ref(false);
const error = ref<string | null>(null);

// ---------------------------------------------------------------------------
// Section data — owned here; SchemaObjectEditor instances v-model into these.
// ---------------------------------------------------------------------------

const configData = reactive<{
  init: Record<string, any>;
  build: Record<string, any>;
  solve: Record<string, any>;
}>({ init: {}, build: {}, solve: {} });

// time_subset is split into two inputs; it is NOT in the Calliope schema as a
// top-level init property, so SchemaObjectEditor won't render it. We handle
// it manually below the init SchemaObjectEditor.
const timeSubsetStart = ref("");
const timeSubsetEnd = ref("");

// ---------------------------------------------------------------------------
// Schema — resolved sub-schemas for each config section.
// ---------------------------------------------------------------------------

const initSchema = computed(() => schemaStore.subschema("config.init") ?? {});
const buildSchema = computed(() => schemaStore.subschema("config.build") ?? {});
const solveSchema = computed(() => schemaStore.subschema("config.solve") ?? {});

// ---------------------------------------------------------------------------
// Overlays — describe the curated subset and any widget overrides.
// Fields not listed (or without hidden:true) appear automatically when Calliope
// adds them to the schema.
// ---------------------------------------------------------------------------

const initOverlay: FieldOverlay = {
  // Visible: name (InputText auto), mode (Select auto from schema enum).
  calliope_version: { hidden: true },
  broadcast_input_data: { hidden: true },
  subset: { hidden: true }, // rendered manually as the time_subset split pair
  resample: { hidden: true },
  time_cluster: { hidden: true },
  datetime_format: { hidden: true },
  date_format: { hidden: true },
  distance_unit: { hidden: true },
  extra_math: { hidden: true },
  math_paths: { hidden: true },
  pre_validate_math_strings: { hidden: true },
};

const buildOverlay: FieldOverlay = {
  // backend: schema enum is pyomo/gurobi; we override to reflect common backends.
  backend: { options: ["pyomo", "highs", "gurobi"] },
  // ensure_feasibility: auto-detected as ToggleSwitch.
  objective: { hidden: true },
  operate: { hidden: true },
};

const solveOverlay: FieldOverlay = {
  // solver: schema type is free string; add a curated Select.
  solver: {
    widget: "Select",
    options: ["cbc", "glpk", "highs", "gurobi", "cplex", "cpsat"],
  },
  zero_threshold: { inputProps: { minFractionDigits: 0, maxFractionDigits: 15 } },
  // spores: show only when mode === 'spores' (checked via context prop).
  spores: { showIf: { field: "$ctx.mode", eq: "spores" } },
  // Hide less-common solve fields.
  postprocessing_active: { hidden: true },
  save_logs: { hidden: true },
  shadow_prices: { hidden: true },
  solver_io: { hidden: true },
  solver_options: { hidden: true },
};

// Overlay for the nested SolveSpores object — show only 'number'.
const sporesOverlay: FieldOverlay = {
  scoring_algorithm: { hidden: true },
  save_per_spore_path: { hidden: true },
  use_latest_results: { hidden: true },
  tracking_parameter: { hidden: true },
  score_threshold_factor: { hidden: true },
};

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

async function load() {
  isLoading.value = true;
  error.value = null;
  try {
    const res = await client.get<{ section: string; data: any }>(
      `/api/versions/${props.versionId}/yaml-section/${props.filePath}?section=config`
    );
    const d = res.data.data ?? {};
    configData.init = d.init ?? {};
    configData.build = d.build ?? {};
    configData.solve = d.solve ?? {};

    // time_subset is stored as an array [start, end] in init.
    const ts =
      configData.init.time_subset ??
      configData.init.subset?.timesteps ??
      null;
    timeSubsetStart.value = Array.isArray(ts) ? (ts[0] ?? "") : "";
    timeSubsetEnd.value = Array.isArray(ts) ? (ts[1] ?? "") : "";
  } catch (e: any) {
    error.value = e?.response?.data?.detail ?? "Failed to load config section.";
  } finally {
    isLoading.value = false;
  }
}

function buildPayload() {
  const init = { ...configData.init };
  // Always write time_subset from the split-pair inputs; remove old subset key.
  delete init.subset;
  delete init.time_subset;
  if (timeSubsetStart.value || timeSubsetEnd.value) {
    init.time_subset = [timeSubsetStart.value, timeSubsetEnd.value];
  }
  return { init, build: { ...configData.build }, solve: { ...configData.solve } };
}

async function save() {
  isSaving.value = true;
  try {
    await client.put(
      `/api/versions/${props.versionId}/yaml-section/${props.filePath}?section=config`,
      { data: buildPayload() }
    );
    editorStore.markClean(props.tabKey);
  } finally {
    isSaving.value = false;
  }
}

// ---------------------------------------------------------------------------
// Dirty tracking — watch reactive state; skip during initial load.
// ---------------------------------------------------------------------------

watch(
  configData,
  () => { if (!isLoading.value) editorStore.markDirty(props.tabKey); },
  { deep: true }
);
watch([timeSubsetStart, timeSubsetEnd], () => {
  if (!isLoading.value) editorStore.markDirty(props.tabKey);
});

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
  // Load schema and YAML section concurrently.
  await Promise.all([load(), schemaStore.load()]);
});

watch(() => props.filePath, load);
</script>

<template>
  <div class="config-editor">
    <div v-if="isLoading" class="placeholder">Loading config…</div>
    <div v-else-if="error" class="placeholder error">{{ error }}</div>
    <template v-else>
      <div class="toolbar">
        <Button label="Save" icon="pi pi-save" size="small" :loading="isSaving" @click="save" />
        <span class="hint">or Ctrl/Cmd+S</span>
      </div>

      <!-- init section -->
      <section class="form-section">
        <h3 class="section-heading">init</h3>
        <SchemaObjectEditor
          :key="filePath + ':init'"
          :schema="initSchema"
          v-model="configData.init"
          :overlay="initOverlay"
        />
        <!-- time_subset — manual split-pair field (not in schema as a property) -->
        <div class="field">
          <label>time_subset</label>
          <div class="inline-pair">
            <InputText v-model="timeSubsetStart" placeholder="start" size="small" />
            <span>→</span>
            <InputText v-model="timeSubsetEnd" placeholder="end" size="small" />
          </div>
        </div>
      </section>

      <!-- build section -->
      <section class="form-section">
        <h3 class="section-heading">build</h3>
        <SchemaObjectEditor
          :key="filePath + ':build'"
          :schema="buildSchema"
          v-model="configData.build"
          :overlay="buildOverlay"
        />
      </section>

      <!-- solve section -->
      <section class="form-section">
        <h3 class="section-heading">solve</h3>
        <SchemaObjectEditor
          :key="filePath + ':solve'"
          :schema="solveSchema"
          v-model="configData.solve"
          :overlay="solveOverlay"
          :context="{ mode: configData.init.mode }"
          :nestedOverlays="{ spores: sporesOverlay }"
        />
      </section>
    </template>
  </div>
</template>

<style scoped>
.config-editor {
  display: flex;
  flex-direction: column;
  padding: 1rem;
  gap: 0.5rem;
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
  margin-bottom: 0.5rem;
}

.hint {
  font-size: 0.75rem;
  color: var(--p-text-muted-color, #888);
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--p-content-border-color, #e0e0e0);
  border-radius: 6px;
}

.section-heading {
  margin: 0 0 0.25rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--p-text-muted-color, #666);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.field label {
  font-size: 0.8rem;
  font-family: monospace;
  color: var(--p-text-color, #333);
}

.inline-pair {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.inline-pair :deep(.p-inputtext) {
  flex: 1;
}

.w-full {
  width: 100%;
}
</style>
