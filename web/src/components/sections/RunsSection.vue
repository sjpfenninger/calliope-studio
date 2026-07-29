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
import StateMessage from "@/components/app/StateMessage.vue";
import PanelFooter from "@/components/app/PanelFooter.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import InfoTip from "@/components/app/InfoTip.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import {
  DANGER_BUTTON_MD,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON_MD,
} from "@/lib/formClasses";
import { Check, HardDrive, Play, RefreshCw, TriangleAlert } from "@lucide/vue";

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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatBytes } from "@/lib/format";
import { ICON_STROKE_WIDTH_TIGHT } from "@/lib/icons";
import { openIntent } from "@/lib/openIntent";
import { RETENTION_CHOICES, useRunsStore, type RunRecord } from "@/stores/runs";
import { useTabsStore } from "@/stores/tabs";

const runs = useRunsStore();
const tabs = useTabsStore();

const starting = ref(false);
const pendingDelete = ref<RunRecord | null>(null);

/**
 * The sentinel for "no scenario" — a `Select` cannot bind to null.
 *
 * It shares a value space with names out of the user's own model, hence the
 * underscores: no Calliope scenario is called this.
 */
const NONE = "__none__";

function setScenario(value: unknown) {
  const name = String(value ?? NONE);
  runs.scenario = name === NONE ? null : name;
}

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
    // Passed from here rather than read inside `startRun`: a later "run this
    // again" on a history item has its own scenario to send, and a store field
    // quietly overriding an argument is hard to see from the call.
    const record = await runs.startRun(tabs.versionId, { scenario: runs.scenario });
    // Opens on the log, because there are no results to show yet.
    tabs.openRun({ id: record.id, label: record.label });
  } finally {
    starting.value = false;
  }
}

const canStart = computed(() => !starting.value && !!tabs.versionId);

function open(run: RunRecord, event: MouseEvent) {
  tabs.openRun(
    { id: run.id, handle: run.results_handle, label: run.label },
    openIntent(event),
  );
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
    <PanelHeader>
      <!-- The trigger is the wrapper, not the button: a disabled control fires
           no pointer events, so a tooltip on one never opens. It only takes the
           button's place in the tab order while the button is out of it. -->
      <InfoTip
        :label="
          runs.scenario
            ? `Solve with ${runs.scenario} applied`
            : 'Solve the model as written'
        "
      >
        <span class="inline-flex" :tabindex="canStart ? undefined : 0">
          <button
            type="button"
            data-testid="start-run"
            :disabled="!canStart"
            :class="PRIMARY_BUTTON"
            @click="start"
          >
            <Play class="size-3.5" />
            Run
          </button>
        </span>
      </InfoTip>

      <RunStatusPill v-if="busy" :status="runs.active[0].status" />

      <div class="flex-1" />
      <TooltipButton label="Reload the run history" :icon="RefreshCw" @click="refresh" />
    </PanelHeader>

    <!-- Its own strip rather than a control in the header above: the sidebar
         narrows to around 200px, that header already holds a button, a status
         pill and an icon button, and a scenario name is as long as the user
         made it. Absent entirely for a model that defines neither scenarios nor
         overrides, which is also every viewer-mode session. -->
    <PanelHeader v-if="runs.hasScenarios" data-testid="scenario-strip">
      <span class="shrink-0 text-2xs text-text-faint">Scenario</span>
      <Select :model-value="runs.scenario ?? NONE" @update:model-value="setScenario">
        <SelectTrigger
          size="sm"
          class="min-w-0 flex-1"
          aria-label="Scenario to run"
          data-testid="run-scenario"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <!-- A real answer rather than an empty one: the model as its files say. -->
          <SelectItem :value="NONE">Model as written</SelectItem>

          <SelectGroup v-if="runs.scenarios.scenarios.length">
            <SelectLabel>Scenarios</SelectLabel>
            <SelectItem
              v-for="entry in runs.scenarios.scenarios"
              :key="entry.name"
              :value="entry.name"
            >
              {{ entry.name }}
              <!-- Marked, not hidden or disabled: Calliope decides whether a
                   scenario resolves, and a model saying one thing while the
                   picker shows another is the worse failure.

                   The trigger is the span rather than the icon: an SVG cannot
                   host one, and it is what carried the `title` before. -->
              <InfoTip
                v-if="entry.missing?.length"
                :label="`Composes overrides this model does not define: ${entry.missing.join(', ')}`"
              >
                <span class="inline-flex items-center">
                  <TriangleAlert class="size-3 text-warning-text" />
                </span>
              </InfoTip>
            </SelectItem>
          </SelectGroup>

          <!-- Offered because `scenario=` takes either: a scenario name, or
               override names. Most models define far more of the latter. -->
          <SelectGroup v-if="runs.scenarios.overrides.length">
            <SelectLabel>Overrides</SelectLabel>
            <SelectItem
              v-for="entry in runs.scenarios.overrides"
              :key="entry.name"
              :value="entry.name"
            >
              {{ entry.name }}
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </PanelHeader>

    <div class="min-h-0 flex-1 overflow-auto" data-testid="run-list">
      <RunListItem
        v-for="run in runs.ordered"
        :key="run.id"
        :run="run"
        :active="run.id === activeRunId"
        @open="open(run, $event)"
        @rename="runs.rename(run.id, $event)"
        @cancel="runs.cancel(run.id)"
        @remove="pendingDelete = run"
      />

      <StateMessage v-if="!runs.ordered.length" variant="inline">
        No runs yet. Solving writes results beside the model, in
        <code class="font-mono text-xs">calliope-studio/runs/</code>.
      </StateMessage>
    </div>

    <!-- What the history costs, and how much of it is kept. Visible because the
         directory is visible: a user told to look in `calliope-studio/` needs to know
         both what it is costing and why old runs disappear. -->
    <PanelFooter v-if="tabs.versionId">
      <HardDrive class="size-3" />
      <span>
        {{ runs.ordered.length }} {{ runs.ordered.length === 1 ? "run" : "runs" }}
      </span>
      <span class="tabular-nums">· {{ formatBytes(runs.totalBytes) }}</span>

      <div class="flex-1" />

      <!-- The tooltip wraps the *whole* menu, not its trigger. See `RunListItem`
           for why: a `Tooltip` between a `DropdownMenu` and its trigger shadows
           the popper context the trigger registers its anchor into. -->
      <InfoTip label="How many finished runs to keep. Applied the next time a run starts.">
        <span class="inline-flex">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button
                type="button"
                data-testid="retention"
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
                  class="size-3" :stroke-width="ICON_STROKE_WIDTH_TIGHT"
                  :class="runs.retention === choice ? '' : 'invisible'"
                />
                {{ choice ?? "All of them" }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </InfoTip>
    </PanelFooter>

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
            :class="SECONDARY_BUTTON_MD"
            @click="pendingDelete = null"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="confirm-delete-run"
            :class="DANGER_BUTTON_MD"
            @click="confirmDelete"
          >
            Delete
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
