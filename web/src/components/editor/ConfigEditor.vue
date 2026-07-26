<script setup lang="ts">
import { ref, reactive, computed, nextTick, onMounted, watch } from "vue";

import client from "@/api/client";
import EditorToolbar from "./EditorToolbar.vue";
import { FIELD, FIELD_LABEL, SECTION, SECTION_HEADING } from "@/lib/formClasses";
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

// ---------------------------------------------------------------------------
// Section data — owned here; SchemaObjectEditor instances v-model into these.
// ---------------------------------------------------------------------------

const configData = reactive<{
  init: Record<string, any>;
  build: Record<string, any>;
  solve: Record<string, any>;
}>({ init: {}, build: {}, solve: {} });

// The time subset is two inputs rather than one list field, because it is a
// start and an end. Rendered by hand: `subset` is a mapping of dimension name to
// range in the schema, which the generic renderer would show as a key/value grid.
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
  // Visible: name (a text field), mode (a select, from the schema enum).
  calliope_version: { hidden: true },
  broadcast_input_data: { hidden: true },
  subset: { hidden: true }, // rendered manually as the two fields below
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
  // ensure_feasibility: auto-detected as a switch.
  objective: { hidden: true },
  operate: { hidden: true },
};

const solveOverlay: FieldOverlay = {
  // solver: the schema type is a free string; offer the ones that exist.
  solver: {
    widget: "select",
    options: ["cbc", "glpk", "highs", "gurobi", "cplex", "cpsat"],
  },
  // A tolerance like 1e-10 must not be rounded by a stepper.
  zero_threshold: { inputProps: { step: "any" } },
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

    // `config.init.subset.timesteps` is where Calliope 0.7 keeps it. The
    // pre-0.7 `time_subset` is still read, so a model carrying one still opens.
    const ts = configData.init.subset?.timesteps ?? configData.init.time_subset ?? null;
    timeSubsetStart.value = Array.isArray(ts) ? (ts[0] ?? "") : "";
    timeSubsetEnd.value = Array.isArray(ts) ? (ts[1] ?? "") : "";
  } catch (e: any) {
    error.value = e?.response?.data?.detail ?? "Failed to load config section.";
  } finally {
    isLoading.value = false;
    // The dirty watchers below are post-flush, so they fire once *after*
    // `isLoading` goes false — with the values load() just wrote. Without this
    // the tab acquired an unsaved-changes dot from merely being opened.
    await nextTick();
    tabsStore.markClean(props.tabId);
  }
}

function buildPayload() {
  const init = { ...configData.init };
  // Written back where Calliope 0.7 reads it. This used to write `time_subset`,
  // which is the *pre*-0.7 spelling and not in the schema at all — so opening
  // the config editor and pressing Save replaced a working `subset:` block with
  // a key Calliope does not accept.
  const { timesteps: _dropped, ...otherSubsets } = (init.subset ?? {}) as Record<
    string,
    unknown
  >;
  delete init.time_subset;
  const subset: Record<string, unknown> = { ...otherSubsets };
  if (timeSubsetStart.value || timeSubsetEnd.value) {
    subset.timesteps = [timeSubsetStart.value, timeSubsetEnd.value];
  }
  if (Object.keys(subset).length) init.subset = subset;
  else delete init.subset;

  return { init, build: { ...configData.build }, solve: { ...configData.solve } };
}

async function save() {
  isSaving.value = true;
  try {
    await client.put(
      `/api/versions/${props.versionId}/yaml-section/${props.filePath}?section=config`,
      { data: buildPayload() }
    );
    tabsStore.markClean(props.tabId);
  } finally {
    isSaving.value = false;
  }
}

// ---------------------------------------------------------------------------
// Dirty tracking — watch reactive state; skip during initial load.
// ---------------------------------------------------------------------------

watch(
  configData,
  () => { if (!isLoading.value) tabsStore.markDirty(props.tabId); },
  { deep: true }
);
watch([timeSubsetStart, timeSubsetEnd], () => {
  if (!isLoading.value) tabsStore.markDirty(props.tabId);
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
  <div class="flex min-h-0 flex-1 flex-col">
    <p v-if="isLoading" class="p-6 text-center text-sm text-muted-foreground">
      Loading config…
    </p>
    <p v-else-if="error" class="p-6 text-center text-sm text-danger-text">{{ error }}</p>

    <template v-else>
      <EditorToolbar :saving="isSaving" @save="save" />

      <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
        <section :class="SECTION">
          <h3 :class="SECTION_HEADING">init</h3>
          <SchemaObjectEditor
            :key="filePath + ':init'"
            v-model="configData.init"
            :schema="initSchema"
            :overlay="initOverlay"
          />
          <!-- time_subset is not a schema property, so it is rendered by hand:
               two fields, because it is a start and an end rather than a list. -->
          <div class="flex flex-col gap-1">
            <label :class="FIELD_LABEL">time_subset</label>
            <div class="flex items-center gap-2">
              <input
                v-model="timeSubsetStart"
                type="text"
                placeholder="start"
                :class="FIELD"
              />
              <span class="text-text-faint">→</span>
              <input
                v-model="timeSubsetEnd"
                type="text"
                placeholder="end"
                :class="FIELD"
              />
            </div>
          </div>
        </section>

        <section :class="SECTION">
          <h3 :class="SECTION_HEADING">build</h3>
          <SchemaObjectEditor
            :key="filePath + ':build'"
            v-model="configData.build"
            :schema="buildSchema"
            :overlay="buildOverlay"
          />
        </section>

        <section :class="SECTION">
          <h3 :class="SECTION_HEADING">solve</h3>
          <SchemaObjectEditor
            :key="filePath + ':solve'"
            v-model="configData.solve"
            :schema="solveSchema"
            :overlay="solveOverlay"
            :context="{ mode: configData.init.mode }"
            :nested-overlays="{ spores: sporesOverlay }"
          />
        </section>
      </div>
    </template>
  </div>
</template>
