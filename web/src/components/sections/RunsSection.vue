<script setup lang="ts">
/**
 * Run history: starting one, and reaching the ones already finished.
 *
 * This closes a loop that did not exist before. The backend has had multi-run
 * support since the first version — per-run records, SSE logs, results per run —
 * and the interface had no list at all: one `activeRun`, no way back to an
 * earlier result, and no way to see or reclaim what the history cost on disk.
 *
 * Clicking Run opens the run's tab immediately, on the log, and the tab picks up
 * its results the moment they exist. That handoff happens in the runs store, so
 * it works whether or not this section is the one being looked at.
 */
import { computed, ref, watch } from "vue";
import { Check, HardDrive, Play, RefreshCw } from "lucide-vue-next";

import RunListItem from "@/components/runs/RunListItem.vue";
import RunStatusPill from "@/components/runs/RunStatusPill.vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatBytes } from "@/lib/format";
import { ICON_STROKE_WIDTH } from "@/lib/icons";
import { RETENTION_CHOICES, useRunsStore, type RunRecord } from "@/stores/runs";
import { useTabsStore } from "@/stores/tabs";

const runs = useRunsStore();
const tabs = useTabsStore();

const starting = ref(false);
const pendingDelete = ref<RunRecord | null>(null);

const busy = computed(() => runs.active.length > 0);

/** Which run tab is in front, so the list can mark it. */
const activeRunId = computed(() =>
  tabs.activeTab?.kind === "run" ? tabs.activeTab.runId : null,
);

/**
 * The version arrives from the route after this mounts, so loading only on mount
 * leaves the list permanently empty. Re-entering the section reloads, which is
 * also how the list picks up a run started from somewhere else.
 *
 * Note what is *not* here: no teardown on unmount. This component unmounts every
 * time the user looks at Model or Files, and a run keeps going regardless — its
 * poll and its log stream belong to the store, not to whichever section happens
 * to be on screen. Only moving to a different model stops them.
 */
watch(
  () => tabs.versionId,
  (versionId, previous) => {
    if (previous && previous !== versionId) runs.stopAll();
    if (versionId) runs.load(versionId);
  },
  { immediate: true },
);

async function start() {
  if (!tabs.versionId || starting.value) return;
  starting.value = true;
  try {
    const record = await runs.startRun(tabs.versionId);
    // Opens on the log, because there are no results to show yet.
    tabs.openRun({ id: record.id, label: record.label });
  } finally {
    starting.value = false;
  }
}

function open(run: RunRecord) {
  tabs.openRun({ id: run.id, handle: run.results_handle, label: run.label });
  if (!runs.isStreaming(run.id)) runs.connectLogs(run.id);
}

async function confirmDelete() {
  const run = pendingDelete.value;
  pendingDelete.value = null;
  if (run) await runs.remove(run.id);
}

function refresh() {
  if (tabs.versionId) runs.load(tabs.versionId);
}

function setRetention(keep: number | null) {
  if (tabs.versionId) runs.setRetention(tabs.versionId, keep);
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div
      class="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-panel px-2"
    >
      <button
        type="button"
        data-testid="start-run"
        :disabled="starting || !tabs.versionId"
        class="inline-flex h-6 items-center gap-1.5 rounded-sm bg-primary px-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        @click="start"
      >
        <Play class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
        Run
      </button>

      <RunStatusPill v-if="busy" :status="runs.active[0].status" />

      <div class="flex-1" />
      <button
        type="button"
        title="Reload the run history"
        class="grid size-6 place-items-center rounded-sm text-text-faint hover:bg-hover hover:text-foreground"
        @click="refresh"
      >
        <RefreshCw class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto" data-testid="run-list">
      <RunListItem
        v-for="run in runs.ordered"
        :key="run.id"
        :run="run"
        :active="run.id === activeRunId"
        @open="open(run)"
        @rename="runs.rename(run.id, $event)"
        @cancel="runs.cancel(run.id)"
        @remove="pendingDelete = run"
      />

      <p v-if="!runs.ordered.length" class="p-3 text-sm text-muted-foreground">
        No runs yet. Solving writes results beside the model, in
        <code class="font-mono text-xs">calligraph/runs/</code>.
      </p>
    </div>

    <!-- What the history costs, and how much of it is kept. Visible because the
         directory is visible: a user told to look in `calligraph/` needs to know
         both what it is costing and why old runs disappear. -->
    <div
      v-if="tabs.versionId"
      class="flex h-6 shrink-0 items-center gap-1.5 border-t border-border px-2 text-2xs text-text-faint"
    >
      <HardDrive class="size-3" :stroke-width="ICON_STROKE_WIDTH" />
      <span>
        {{ runs.ordered.length }} {{ runs.ordered.length === 1 ? "run" : "runs" }}
      </span>
      <span class="tabular-nums">· {{ formatBytes(runs.totalBytes) }}</span>

      <div class="flex-1" />

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            data-testid="retention"
            title="How many finished runs to keep. Applied the next time a run starts."
            class="rounded-xs px-1 hover:bg-hover hover:text-foreground"
          >
            keep {{ runs.retention === null ? "all" : runs.retention }}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="min-w-32">
          <DropdownMenuLabel class="text-2xs">Keep how many runs</DropdownMenuLabel>
          <DropdownMenuItem
            v-for="choice in RETENTION_CHOICES"
            :key="String(choice)"
            :data-testid="`retention-${choice ?? 'all'}`"
            @select="setRetention(choice)"
          >
            <Check
              class="size-3"
              :stroke-width="2.5"
              :class="runs.retention === choice ? '' : 'invisible'"
            />
            {{ choice ?? "All of them" }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <Dialog
      :open="pendingDelete !== null"
      @update:open="(open) => !open && (pendingDelete = null)"
    >
      <DialogContent class="sm:max-w-96">
        <DialogHeader>
          <DialogTitle>Delete this run?</DialogTitle>
          <DialogDescription>
            Its results, log and frozen configuration are removed from disk. This
            cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            class="inline-flex h-7 items-center rounded-sm border border-border px-3 text-sm hover:bg-hover"
            @click="pendingDelete = null"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="confirm-delete-run"
            class="inline-flex h-7 items-center rounded-sm bg-destructive px-3 text-sm font-medium text-destructive-foreground hover:opacity-90"
            @click="confirmDelete"
          >
            Delete
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
