<script setup lang="ts">
/**
 * One run, in a tab: its results, the configuration it was solved from, and its
 * log.
 *
 * These three belong together and were previously in three different places —
 * results on their own route, the log in a side panel that vanished when you
 * navigated, and the configuration nowhere at all, because nothing recorded what
 * a run had actually been given.
 *
 * Sub-views are latched: a pane is created the first time it is shown and
 * `v-show`n after that. Building the results pane inside a hidden container
 * would hand MapLibre a zero-size element and it would fit its bounds to
 * nothing; keeping it alive afterwards is what makes switching sub-views (and
 * tabs) cost no frame request.
 */
import { computed, onMounted, ref, watch } from "vue";
import Segmented from "@/components/app/Segmented.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import StateMessage from "@/components/app/StateMessage.vue";

import RunConfigPanel from "./RunConfigPanel.vue";
import RunLogPanel from "./RunLogPanel.vue";
import RunResultsPanel from "./RunResultsPanel.vue";
import { isTerminal, useRunsStore } from "@/stores/runs";
import { useTabsStore, type RunSubView, type RunTab } from "@/stores/tabs";

const props = defineProps<{ tab: RunTab }>();

const tabs = useTabsStore();
const runs = useRunsStore();

const run = computed(() => (props.tab.runId ? runs.get(props.tab.runId) : undefined));

const VIEWS: Array<{ id: RunSubView; label: string }> = [
  { id: "results", label: "Results" },
  { id: "config", label: "Config" },
  { id: "log", label: "Log" },
];

/** A bare `.nc` has no run behind it, so there is no log and nothing was frozen. */
const available = computed<Record<RunSubView, boolean>>(() => ({
  results: props.tab.handle !== null,
  config: props.tab.runId !== null,
  log: props.tab.runId !== null,
}));

/** The sub-tab strip, as `Segmented` items. */
const segments = computed(() =>
  VIEWS.map((view) => ({
    value: view.id,
    label: view.label,
    disabled: !available.value[view.id],
    tip: available.value[view.id] ? undefined : "Not available for a results file",
    testid: `run-subtab-${view.id}`,
  })),
);

function shows(view: RunSubView) {
  return props.tab.seenViews.includes(view) && available.value[view];
}

/** True once we know the run this tab names is not on disk. */
const missing = ref(false);

/**
 * Makes sure this tab has the run behind it, however it was opened.
 *
 * A cold load from `?tab=run:…` reaches here with the runs store empty — the
 * Runs section may never have been looked at — so the record, the poll and the
 * log all have to be arranged from here as well as from the list.
 */
onMounted(async () => {
  const runId = props.tab.runId;
  if (!runId) return;

  if (!runs.get(runId)) await runs.refresh(runId);
  const record = runs.get(runId);
  // A tab restored from a previous session can outlive the run it names —
  // deleted here, or pruned by retention. Say so rather than showing an empty
  // log and a config panel that 404s.
  missing.value = !record;
  if (record && !isTerminal(record.status)) runs.watchRun(runId);
});

// The log is fetched when it is first looked at rather than on open: the server
// replays the whole event file, and a finished run's log is dead weight for
// someone who came to see the charts.
watch(
  () => props.tab.subView,
  (view) => {
    const runId = props.tab.runId;
    // `logs.has` rather than a length check: an empty buffer and a buffer that
    // was never fetched are different things.
    if (view === "log" && runId && !runs.logs.has(runId)) runs.connectLogs(runId);
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PanelHeader data-testid="run-subtabs" size="sm" class="px-1">
      <Segmented
        :model-value="tab.subView"
        :items="segments"
        mode="nav"
        seam="none"
        size="sm"
        @update:model-value="$event && tabs.setSubView(tab.id, $event)"
      />

      <div class="flex-1" />
      <span v-if="run?.label" class="self-center truncate px-2 text-2xs text-text-faint">
        {{ run.id.slice(0, 8) }}
      </span>
    </PanelHeader>

    <div class="relative min-h-0 flex-1">
      <StateMessage v-if="missing" variant="fill" class="absolute inset-0">
        This run is no longer on disk. Close the tab, or start a new run.
      </StateMessage>

      <RunResultsPanel
        v-if="shows('results') && tab.handle"
        v-show="tab.subView === 'results'"
        :handle="tab.handle"
        class="absolute inset-0 flex"
      />

      <RunConfigPanel
        v-if="!missing && shows('config') && tab.runId"
        v-show="tab.subView === 'config'"
        :run-id="tab.runId"
        :handle="tab.handle"
        class="absolute inset-0 flex"
      />

      <RunLogPanel
        v-if="!missing && shows('log') && tab.runId"
        v-show="tab.subView === 'log'"
        :run-id="tab.runId"
        class="absolute inset-0 flex"
      />

      <StateMessage v-if="!missing && tab.subView === 'results' && !tab.handle" variant="fill" class="absolute inset-0">
        This run has not produced results.
      </StateMessage>
    </div>
  </div>
</template>
