<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import Select from "primevue/select";
import SelectButton from "primevue/selectbutton";
import Message from "primevue/message";
import ProgressSpinner from "primevue/progressspinner";
import FilterSidebar from "../components/results/FilterSidebar.vue";
import ResultChart from "../components/results/ResultChart.vue";
import { useResultFrame } from "../composables/useResultFrame";
import { RESOLUTIONS, useSelectionStore } from "../stores/selection";
import client from "../api/client";

const route = useRoute();
const store = useSelectionStore();

const handle = ref<string | null>(null);

const timeseriesFrame = useResultFrame(
  handle,
  computed(() => store.timeseriesQuery),
);
const staticFrame = useResultFrame(
  handle,
  computed(() => store.staticQuery),
);

const plotTypes = ["Bar", "Line", "Area", "Duration"];
const resolutions = Object.keys(RESOLUTIONS);
const sumByOptions = [
  { label: "Sum over nodes", value: "nodes" },
  { label: "Sum over techs", value: "techs" },
];

async function resolveHandle(): Promise<string | null> {
  // A run id in the route means "show me this run's results"; otherwise fall
  // back to whatever the server was opened on, which is how `calligraph
  // results.nc` lands straight here.
  const runId = route.params.runId as string | undefined;
  if (runId) {
    const run = await client.get(`/api/runs/${runId}/`);
    return run.data.results_handle ?? null;
  }
  const health = await client.get("/api/health");
  return health.data.results_handle ?? null;
}

async function open() {
  const resolved = await resolveHandle();
  handle.value = resolved;
  if (resolved) await store.load(resolved);
}

onMounted(open);
watch(() => route.params.runId, open);

const timeseriesVariables = computed(
  () => store.catalog?.variables.timeseries ?? [],
);
const staticVariables = computed(() => store.catalog?.variables.static ?? []);
</script>

<template>
  <div class="results">
    <div v-if="!handle && !store.isLoading" class="empty">
      <Message severity="info" :closable="false">
        No results to show yet. Run the model, or open Calligraph on a
        <code>results.nc</code> file.
      </Message>
    </div>

    <template v-else>
      <FilterSidebar class="sidebar" />

      <main class="panes">
        <ProgressSpinner v-if="store.isLoading" style="width: 32px" />

        <template v-else>
          <section class="pane">
            <header class="controls">
              <Select
                v-model="store.variableTimeseries"
                :options="timeseriesVariables"
                filter
                placeholder="Variable"
                class="variable"
              />
              <SelectButton
                v-model="store.plotType"
                :options="plotTypes"
                :allow-empty="false"
                size="small"
              />
              <SelectButton
                v-model="store.resolution"
                :options="resolutions"
                :allow-empty="false"
                size="small"
              />
              <Select
                v-model="store.sumBy"
                :options="sumByOptions"
                option-label="label"
                option-value="value"
                size="small"
              />
            </header>
            <ResultChart
              :frame="timeseriesFrame.frame.value"
              :kind="store.timeseriesKind"
              :loading="timeseriesFrame.loading.value"
              :error="timeseriesFrame.error.value"
              height="380px"
            />
          </section>

          <section class="pane">
            <header class="controls">
              <Select
                v-model="store.variableStatic"
                :options="staticVariables"
                filter
                placeholder="Variable"
                class="variable"
              />
            </header>
            <ResultChart
              :frame="staticFrame.frame.value"
              kind="bar"
              :loading="staticFrame.loading.value"
              :error="staticFrame.error.value"
              height="300px"
            />
          </section>
        </template>
      </main>
    </template>
  </div>
</template>

<style scoped>
.results {
  display: grid;
  grid-template-columns: 260px 1fr;
  height: 100%;
  min-height: 0;
}

.sidebar {
  border-right: 1px solid var(--p-content-border-color);
  min-height: 0;
}

.panes {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
  overflow-y: auto;
  min-height: 0;
}

.pane {
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
  padding: 0.75rem;
  background: var(--p-surface-0);
}

.controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}

.variable {
  min-width: 200px;
}

.empty {
  padding: 2rem;
  grid-column: 1 / -1;
}
</style>
