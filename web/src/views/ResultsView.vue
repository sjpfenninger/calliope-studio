<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import Select from "primevue/select";
import SelectButton from "primevue/selectbutton";
import Message from "primevue/message";
import ProgressSpinner from "primevue/progressspinner";
import Button from "primevue/button";
import FilterSidebar from "../components/results/FilterSidebar.vue";
import ResultChart from "../components/results/ResultChart.vue";
import ModelMap, { type GeoPayload } from "../components/map/ModelMap.vue";
import { useResultFrame } from "../composables/useResultFrame";
import { RESOLUTIONS, useSelectionStore } from "../stores/selection";
import { fetchGeo } from "../api/results";
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
const mapFrame = useResultFrame(
  handle,
  computed(() => store.mapQuery),
);

const geo = ref<GeoPayload | null>(null);

/**
 * Per-node totals for the map, keyed by node.
 *
 * The map query is indexed by node and summed over technologies, so each series
 * is one node and its first value is that node's total.
 */
const mapValues = computed<Record<string, number>>(() => {
  const frame = mapFrame.frame.value;
  if (!frame) return {};
  const totals: Record<string, number> = {};
  frame.index.forEach((node, position) => {
    const sum = frame.series.reduce((running, series) => {
      const value = series.values[position];
      return Number.isNaN(value) ? running : running + value;
    }, 0);
    if (sum !== 0) totals[String(node)] = sum;
  });
  return totals;
});

const plotTypes = ["Bar", "Line", "Area", "Duration"];
const resolutions = Object.keys(RESOLUTIONS);
const sumByOptions = [
  { label: "Sum over nodes", value: "nodes" },
  { label: "Sum over techs", value: "techs" },
];

async function resolveHandle(): Promise<string | null> {
  // A run id in the route means "show me this run's results".
  const runId = route.params.runId as string | undefined;
  if (runId) {
    const run = await client.get(`/api/runs/${runId}/`);
    return run.data.results_handle ?? null;
  }

  // Opening Calligraph on a `results.nc` lands straight here.
  const health = await client.get("/api/health");
  if (health.data.results_handle) return health.data.results_handle;

  // Otherwise show the most recent run that produced results. Running a model
  // and then clicking Results should show them, without having to find the run
  // in a list first.
  const workspace = health.data.workspace_id;
  if (!workspace) return null;
  const runs = await client.get(`/api/versions/${workspace}/runs/`);
  const latest = (runs.data ?? []).find((run: any) => run.results_handle);
  return latest?.results_handle ?? null;
}

async function open() {
  const resolved = await resolveHandle();
  handle.value = resolved;
  geo.value = null;
  store.mapNodes = [];
  if (!resolved) return;
  await store.load(resolved);
  try {
    geo.value = await fetchGeo(resolved);
  } catch {
    // A model without coordinates is perfectly normal; the map says so itself.
    geo.value = null;
  }
}

const hasGeography = computed(
  () => (geo.value?.nodes.features.length ?? 0) > 0,
);

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
          <section v-if="hasGeography" class="pane">
            <header class="controls">
              <span class="pane-title">
                {{ store.variableStatic }} by node
              </span>
              <span v-if="store.mapNodes.length" class="filter-note">
                Charts narrowed to {{ store.mapNodes.join(", ") }}
                <Button
                  text
                  size="small"
                  label="Clear"
                  @click="store.mapNodes = []"
                />
              </span>
              <span v-else class="filter-note muted">
                Click nodes to narrow the charts below.
              </span>
            </header>
            <ModelMap
              v-model:selected="store.mapNodes"
              :geo="geo"
              :values="mapValues"
              height="320px"
            />
          </section>

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

.pane-title {
  font-size: 0.85rem;
  font-weight: 600;
}

.filter-note {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  margin-left: auto;
}

.filter-note.muted {
  color: var(--p-text-muted-color, #888);
}

.empty {
  padding: 2rem;
  grid-column: 1 / -1;
}
</style>
