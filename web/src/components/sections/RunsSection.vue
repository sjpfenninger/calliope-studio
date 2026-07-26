<script setup lang="ts">
/**
 * Starting runs, and reaching the ones already finished.
 *
 * The full history list arrives with the runs store; for now this is the start
 * button and the live status, moved out of the side panel that used to hold it.
 * That panel never linked to the results it produced, which is the gap the run
 * tab closes: starting a run opens its tab immediately, on the log, and the tab
 * switches to the charts when results appear.
 */
import { computed } from "vue";
import { Play } from "lucide-vue-next";

import { ICON_STROKE_WIDTH } from "@/lib/icons";
import { useRunStore, type RunStatus } from "@/stores/run";
import { useTabsStore } from "@/stores/tabs";

const runs = useRunStore();
const tabs = useTabsStore();

const isRunning = computed(() => runs.activeRun?.status === "running");

/**
 * `infeasible` is amber, not red: the worker treats it as a legitimate outcome —
 * the model solved and was found infeasible — so painting it as a failure tells
 * the user their software broke when their model is what needs attention.
 */
const STATUS_STYLE: Record<RunStatus, string> = {
  pending: "border-border bg-muted text-muted-foreground",
  running: "border-accent-border bg-accent-soft text-accent-text",
  success: "border-success/30 bg-success-soft text-success-text",
  infeasible: "border-warning/30 bg-warning-soft text-warning-text",
  failed: "border-danger/30 bg-danger-soft text-danger-text",
  cancelled: "border-border bg-muted text-muted-foreground line-through decoration-1",
};

const STATUS_DOT: Record<RunStatus, string> = {
  pending: "bg-text-faint",
  running: "bg-primary animate-pulse",
  success: "bg-success",
  infeasible: "bg-warning",
  failed: "bg-danger",
  cancelled: "bg-text-faint",
};

async function start() {
  if (!tabs.versionId) return;
  await runs.startRun(tabs.versionId);
  // Opens on the log, because there are no results to show yet.
  if (runs.activeRun) tabs.openRun({ id: runs.activeRun.id });
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div
      class="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-panel px-2"
    >
      <button
        type="button"
        data-testid="start-run"
        :disabled="isRunning || !tabs.versionId"
        class="inline-flex h-6 items-center gap-1.5 rounded-sm bg-primary px-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        @click="start"
      >
        <Play class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
        Run
      </button>

      <span
        v-if="runs.activeRun"
        data-testid="run-status"
        class="inline-flex h-5 items-center gap-1.5 rounded-xs border px-1.5 text-xs font-medium capitalize"
        :class="STATUS_STYLE[runs.activeRun.status]"
      >
        <span class="size-1.5 rounded-full" :class="STATUS_DOT[runs.activeRun.status]" />
        {{ runs.activeRun.status }}
      </span>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <button
        v-if="runs.activeRun"
        type="button"
        class="flex w-full flex-col items-start gap-0.5 border-b border-border-subtle px-2 py-1.5 text-left hover:bg-hover"
        @click="tabs.openRun({ id: runs.activeRun.id })"
      >
        <span class="truncate text-sm">{{ runs.activeRun.id.slice(0, 8) }}</span>
        <span class="text-2xs text-text-faint">{{ runs.activeRun.created_at }}</span>
      </button>
      <p v-else class="p-3 text-sm text-muted-foreground">
        No runs yet. Solving writes results beside the model, in
        <code class="font-mono text-xs">calligraph/runs/</code>.
      </p>
    </div>
  </div>
</template>
