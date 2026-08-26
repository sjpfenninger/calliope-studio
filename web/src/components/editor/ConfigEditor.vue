<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from "vue";
import StateMessage from "@/components/app/StateMessage.vue";
import FieldRow from "@/components/app/FieldRow.vue";

import { useSectionEditor } from "@/composables/useSectionEditor";
import EditorToolbar from "./EditorToolbar.vue";
import Eyebrow from "@/components/app/Eyebrow.vue";
import { FIELD, FIELD_WIDTH, SECTION } from "@/lib/formClasses";
import { cn } from "@/lib/utils";
import { useSchemaStore } from "@/stores/schema";
import { useRunsStore } from "@/stores/runs";
import SchemaObjectEditor, { type FieldOverlay } from "./SchemaObjectEditor.vue";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabId: string;
}>();

const schemaStore = useSchemaStore();
// The solver suggestions are a question about where runs happen, not about
// what the schema allows, so they come from the runs store.
const runsStore = useRunsStore();

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
  // A model name is prose, not an identifier — the one string here that earns
  // the full width a schema-driven text field no longer gets by default.
  name: { width: "fill" },
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

// backend: the schema's own enum, which is `pyomo | gurobi`. It used to be
// overridden to add `highs` — a backend Calliope does not have, so choosing it
// produced a model that would not load.
const buildOverlay: FieldOverlay = {
  // ensure_feasibility: auto-detected as a switch.
  objective: { hidden: true },
  operate: { hidden: true },
};

const solveOverlay = computed<FieldOverlay>(() => ({
  // A free string in the schema, and it means it — Calliope takes any name with
  // a Pyomo interface. So: suggestions from what this machine can actually
  // reach, and no constraint. The list used to be six names written here, of
  // which one was installed and two were not Pyomo solvers at all.
  solver: { widget: "text", suggestions: runsStore.solvers },
  // A tolerance like 1e-10 must not be rounded by a stepper, and needs more
  // room than a plain number: the exponent plus the spinner does not fit 64px.
  zero_threshold: { inputProps: { step: "any" }, width: "short" },
  // spores: show only when mode === 'spores' (checked via context prop).
  spores: { showIf: { field: "$ctx.mode", eq: "spores" } },
  // Hide less-common solve fields.
  postprocessing_active: { hidden: true },
  save_logs: { hidden: true },
  shadow_prices: { hidden: true },
  solver_io: { hidden: true },
  solver_options: { hidden: true },
}));

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

const { isLoading, isSaving, error, saveError, save, markDirty } = useSectionEditor({
  versionId: () => props.versionId,
  filePath: () => props.filePath,
  tabId: () => props.tabId,
  section: "config",
  label: "the config section",
  apply(data) {
    configData.init = data.init ?? {};
    configData.build = data.build ?? {};
    configData.solve = data.solve ?? {};

    // `config.init.subset.timesteps` is where Calliope 0.7 keeps it. The
    // pre-0.7 `time_subset` is still read, so a model carrying one still opens.
    const ts = configData.init.subset?.timesteps ?? configData.init.time_subset ?? null;
    timeSubsetStart.value = Array.isArray(ts) ? (ts[0] ?? "") : "";
    timeSubsetEnd.value = Array.isArray(ts) ? (ts[1] ?? "") : "";
  },
  build: buildPayload,
});

// ---------------------------------------------------------------------------
// Dirty tracking — watch reactive state; skip during initial load.
// ---------------------------------------------------------------------------

watch(
  configData,
  () => { if (!isLoading.value) markDirty(); },
  { deep: true }
);
watch([timeSubsetStart, timeSubsetEnd], () => {
  if (!isLoading.value) markDirty();
});

// ---------------------------------------------------------------------------
// Keyboard shortcut
// ---------------------------------------------------------------------------

// The section load and its lifecycle belong to the composable; the schema is
// this editor's own and is fetched alongside it rather than after it.
onMounted(() => {
  void schemaStore.load();
  // Only this editor suggests solvers, so it is not folded into the schema
  // store's `load()` — which every editor that mounts Monaco calls.
  void runsStore.loadSolvers(props.versionId);
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <StateMessage v-if="isLoading" variant="block" loading>
      Loading config…
    </StateMessage>
    <StateMessage v-else-if="error" variant="block" tone="danger">{{ error }}</StateMessage>

    <template v-else>
      <EditorToolbar :saving="isSaving" :error="saveError" :file="filePath" @save="save" />

      <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
        <section :class="SECTION">
          <Eyebrow class="mb-0">init</Eyebrow>
          <SchemaObjectEditor
            :key="filePath + ':init'"
            v-model="configData.init"
            :schema="initSchema"
            :overlay="initOverlay"
          />
          <!-- time_subset is not a schema property, so it is rendered by hand:
               two fields, because it is a start and an end rather than a list. -->
          <FieldRow label="time_subset">
            <div class="flex items-center gap-2">
              <input
                v-model="timeSubsetStart"
                type="text"
                placeholder="start"
                :class="cn(FIELD, FIELD_WIDTH.short)"
              />
              <span class="text-text-faint">→</span>
              <input
                v-model="timeSubsetEnd"
                type="text"
                placeholder="end"
                :class="cn(FIELD, FIELD_WIDTH.short)"
              />
            </div>
          </FieldRow>
        </section>

        <section :class="SECTION">
          <Eyebrow class="mb-0">build</Eyebrow>
          <SchemaObjectEditor
            :key="filePath + ':build'"
            v-model="configData.build"
            :schema="buildSchema"
            :overlay="buildOverlay"
          />
        </section>

        <section :class="SECTION">
          <Eyebrow class="mb-0">solve</Eyebrow>
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
