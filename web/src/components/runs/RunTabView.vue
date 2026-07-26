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
import { computed, onMounted, watch } from "vue";

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

function shows(view: RunSubView) {
  return props.tab.seenViews.includes(view) && available.value[view];
}

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
    <div
      data-testid="run-subtabs"
      class="flex h-7 shrink-0 items-stretch border-b border-border bg-panel px-1"
    >
      <button
        v-for="view in VIEWS"
        :key="view.id"
        type="button"
        :data-testid="`run-subtab-${view.id}`"
        :data-active="tab.subView === view.id || undefined"
        :disabled="!available[view.id]"
        class="relative inline-flex items-center px-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground data-[active]:text-foreground data-[active]:after:absolute data-[active]:after:inset-x-1 data-[active]:after:bottom-0 data-[active]:after:h-0.5 data-[active]:after:bg-primary"
        @click="tabs.setSubView(tab.id, view.id)"
      >
        {{ view.label }}
      </button>

      <div class="flex-1" />
      <span v-if="run?.label" class="self-center truncate px-2 text-2xs text-text-faint">
        {{ run.id.slice(0, 8) }}
      </span>
    </div>

    <div class="relative min-h-0 flex-1">
      <RunResultsPanel
        v-if="shows('results') && tab.handle"
        v-show="tab.subView === 'results'"
        :handle="tab.handle"
        class="absolute inset-0 flex"
      />

      <RunConfigPanel
        v-if="shows('config') && tab.runId"
        v-show="tab.subView === 'config'"
        :run-id="tab.runId"
        :handle="tab.handle"
        class="absolute inset-0 flex"
      />

      <RunLogPanel
        v-if="shows('log') && tab.runId"
        v-show="tab.subView === 'log'"
        :run-id="tab.runId"
        class="absolute inset-0 flex"
      />

      <p
        v-if="tab.subView === 'results' && !tab.handle"
        class="absolute inset-0 grid place-items-center text-sm text-muted-foreground"
      >
        This run has not produced results.
      </p>
    </div>
  </div>
</template>
