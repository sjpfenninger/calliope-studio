<script setup lang="ts">
import { reactive, computed, onMounted, ref, watch } from "vue";
import StateMessage from "@/components/app/StateMessage.vue";

import { useSectionEditor } from "@/composables/useSectionEditor";
import EditorToolbar from "./EditorToolbar.vue";
import Eyebrow from "@/components/app/Eyebrow.vue";
import { SECTION } from "@/lib/formClasses";
import { useSchemaStore } from "@/stores/schema";
import { useRunsStore } from "@/stores/runs";
import { useUiStore } from "@/stores/ui";
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
const ui = useUiStore();

// ---------------------------------------------------------------------------
// Section data — owned here; SchemaObjectEditor instances v-model into these.
// ---------------------------------------------------------------------------

const configData = reactive<{
  init: Record<string, any>;
  build: Record<string, any>;
  solve: Record<string, any>;
}>({ init: {}, build: {}, solve: {} });

// ---------------------------------------------------------------------------
// Schema — resolved sub-schemas for each config section.
// ---------------------------------------------------------------------------

const initSchema = computed(() => schemaStore.subschema("config.init") ?? {});
const buildSchema = computed(() => schemaStore.subschema("config.build") ?? {});
const solveSchema = computed(() => schemaStore.subschema("config.solve") ?? {});

// ---------------------------------------------------------------------------
// Overlays — which tier each field sits in, and any widget overrides.
//
// `tier: "advanced"` collapses a field the model does not set; a field it *does*
// set is shown regardless. So this decides the shape of an empty form and
// nothing about what an existing model shows, which is what it used to get
// wrong: `hidden: true` meant "less common" here, and a model carrying
// `datetime_format` and `shadow_prices` displayed neither.
//
// A property not listed at all is common and auto-detected, so one Calliope adds
// appears on its own.
// ---------------------------------------------------------------------------

/**
 * The Math tab declares and enables math files, and writes `config` directly.
 *
 * Two writers for one key is how one panel's settings get reverted by whichever
 * editor was mounted with a staler copy of the section, so these stay read-only
 * here — but visible, which they were not.
 */
const MATH_OWNER = {
  label: "Math",
  hint: "Declared and enabled on the Math tab, which owns these two keys.",
};

const initOverlay: FieldOverlay = {
  // A model name is prose, not an identifier — the one string here that earns
  // the full width a schema-driven text field no longer gets by default.
  name: { width: "fill" },
  // Two boxes rather than a comma-separated list, because a time subset is a
  // start and an end. A dimension subset that is not a range — `subset.nodes` —
  // degrades to the same pair rather than to a second control.
  subset: { widget: "keyValueRange" },
  math_paths: { ownedBy: MATH_OWNER },
  extra_math: { ownedBy: MATH_OWNER },
  // The pre-0.7 spelling. `apply` reads it into `subset.timesteps` and the save
  // drops it, so the unrecognised row explains that instead of offering Remove,
  // which would throw the value away.
  time_subset: {
    expected: "The pre-0.7 spelling. Saved as subset.timesteps, and removed.",
  },
  calliope_version: { tier: "advanced" },
  broadcast_input_data: { tier: "advanced" },
  retain_inactive: { tier: "advanced" },
  resample: { tier: "advanced" },
  time_cluster: { tier: "advanced" },
  datetime_format: { tier: "advanced", width: "fill" },
  date_format: { tier: "advanced", width: "fill" },
  distance_unit: { tier: "advanced" },
  pre_validate_math_strings: { tier: "advanced" },
};

// backend and ensure_feasibility are auto-detected — a select from the schema's
// own enum, and a switch.
const buildOverlay: FieldOverlay = {
  objective: { tier: "advanced" },
  // Operate mode's rolling window, which is meaningless in any other mode. A
  // model that sets it anyway still shows it, which is when it matters most.
  operate: { tier: "advanced", showIf: { field: "$ctx.mode", eq: "operate" } },
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
  // spores: only meaningful in spores mode, and shown in full when it is.
  spores: { showIf: { field: "$ctx.mode", eq: "spores" } },
  postprocessing_active: { tier: "advanced" },
  save_logs: { tier: "advanced", width: "fill" },
  shadow_prices: { tier: "advanced" },
  solver_io: { tier: "advanced" },
  solver_options: { tier: "advanced" },
}));

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/** Which of the three config sections the file actually declared. */
const loadedSections = ref<Set<string>>(new Set());

function buildPayload() {
  const init = { ...configData.init };
  // Written back where Calliope 0.7 reads it. This used to write `time_subset`,
  // which is the *pre*-0.7 spelling and not in the schema at all — so opening
  // the config editor and pressing Save replaced a working `subset:` block with
  // a key Calliope does not accept. `apply` has already folded it the other way.
  delete init.time_subset;

  // A section the file did not have and the form did not fill in is left out.
  // Emitting all three unconditionally meant a model declaring only
  // `config.init` gained `build: {}` and `solve: {}` from a save that changed
  // nothing else — the no-op-save invariant, broken by the editor rather than
  // by the YAML layer. `config-check` did not catch it because Calliope's own
  // example models declare all three.
  const payload: Record<string, unknown> = {};
  for (const [name, values] of [
    ["init", init],
    ["build", { ...configData.build }],
    ["solve", { ...configData.solve }],
  ] as const) {
    if (loadedSections.value.has(name) || Object.keys(values).length > 0) {
      payload[name] = values;
    }
  }
  return payload;
}

const { isLoading, isSaving, error, saveError, save, markDirty } = useSectionEditor({
  versionId: () => props.versionId,
  filePath: () => props.filePath,
  tabId: () => props.tabId,
  section: "config",
  label: "the config section",
  apply(data) {
    const init = { ...(data.init ?? {}) };
    // `config.init.subset.timesteps` is where Calliope 0.7 keeps it. A model
    // written for 0.6 says `time_subset`, and is read into the modern shape so
    // the form edits one thing rather than two that disagree.
    const legacy = init.time_subset;
    if (Array.isArray(legacy) && init.subset?.timesteps == null) {
      init.subset = { ...(init.subset ?? {}), timesteps: legacy };
    }
    configData.init = init;
    configData.build = data.build ?? {};
    configData.solve = data.solve ?? {};
    loadedSections.value = new Set(
      (["init", "build", "solve"] as const).filter((name) => name in data),
    );
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
            :show-advanced="ui.configAdvanced.init"
            @update:show-advanced="ui.setConfigAdvanced('init', $event)"
          />
        </section>

        <section :class="SECTION">
          <Eyebrow class="mb-0">build</Eyebrow>
          <SchemaObjectEditor
            :key="filePath + ':build'"
            v-model="configData.build"
            :schema="buildSchema"
            :overlay="buildOverlay"
            :context="{ mode: configData.init.mode }"
            :show-advanced="ui.configAdvanced.build"
            @update:show-advanced="ui.setConfigAdvanced('build', $event)"
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
            :show-advanced="ui.configAdvanced.solve"
            @update:show-advanced="ui.setConfigAdvanced('solve', $event)"
          />
        </section>
      </div>
    </template>
  </div>
</template>
