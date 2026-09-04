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
  FIELD_LABEL,
  IDENTIFIER,
  PRIMARY_BUTTON,
  TEXT_BUTTON_SM,
  WARNING_BADGE,
} from "@/lib/formClasses";
import { Check, GitCompare, HardDrive, Play, RefreshCw } from "@lucide/vue";

import RunListItem from "@/components/runs/RunListItem.vue";
import RunStatusPill from "@/components/runs/RunStatusPill.vue";
import { Badge } from "@/components/ui/badge";
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
import { errorDetail } from "@/api/errors";
import { formatBytes, formatCount } from "@/lib/format";
import { ICON_STROKE_WIDTH_TIGHT } from "@/lib/icons";
import { openIntent } from "@/lib/openIntent";
import { runRef, workspaceRef, type CompareRef } from "@/lib/compareRef";
import { cn } from "@/lib/utils";
import { useConfirmStore } from "@/stores/confirm";
import { RETENTION_CHOICES, useRunsStore, type RunRecord } from "@/stores/runs";
import { useTabsStore } from "@/stores/tabs";

const runs = useRunsStore();
const tabs = useTabsStore();

const starting = ref(false);

/**
 * Why the last action failed, shown at the top of the list. One surface for
 * all five actions — start, cancel, rename, delete, retention — because each
 * otherwise fails into a rejected promise nobody holds: the button re-enables,
 * the dialog is gone, the menu snaps back, and nothing says why.
 */
const actionError = ref<string | null>(null);

async function attempt(label: string, action: () => Promise<unknown>): Promise<void> {
  actionError.value = null;
  try {
    await action();
  } catch (caught) {
    actionError.value = errorDetail(caught, `${label} failed.`);
  }
}

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
 * Note what is *not* here: no teardown on unmount, and no stopping of the
 * previous model's polls. This component unmounts every time the user looks at
 * Model or Files, and a run keeps going regardless — its poll and its log
 * stream belong to the store, not to whichever section happens to be on
 * screen. Stopping them on a model switch was here and could not work from
 * here: a switch made from Model or Files remounts this and fires the watcher
 * `immediate`, with no previous value to compare against, so nothing was
 * stopped and the old model's runs kept polling into the new model's list.
 * `AppShell`'s version watcher does it now, and `runs.load` does it again for
 * anything that reaches the store by another route.
 */
watch(
  () => tabs.versionId,
  (versionId) => {
    if (versionId) runs.load(versionId);
  },
  { immediate: true },
);

async function start() {
  if (!tabs.versionId || starting.value) return;
  starting.value = true;
  try {
    await attempt("Starting the run", async () => {
      // Passed from here rather than read inside `startRun`: a later "run this
      // again" on a history item has its own scenario to send, and a store field
      // quietly overriding an argument is hard to see from the call.
      const record = await runs.startRun(tabs.versionId!, { scenario: runs.scenario });
      // Opens on the log, because there are no results to show yet.
      tabs.openRun({ id: record.id, label: record.label });
    });
  } finally {
    starting.value = false;
  }
}

const canStart = computed(() => !starting.value && !!tabs.versionId);

// The wrapper below keeps a disabled button's tooltip reachable precisely so
// it can say why. Enabled during a run, deliberately: two solves at once is a
// thing the server supports and the list shows.
const runTip = computed(() =>
  !tabs.versionId
    ? "No model is open."
    : starting.value
      ? "Starting the run…"
      : runs.scenario
        ? `Solve with ${runs.scenario} applied.`
        : "Solve the model as written.",
);

function open(run: RunRecord, event: MouseEvent) {
  tabs.openRun(
    { id: run.id, handle: run.results_handle, label: run.label },
    openIntent(event),
  );
  if (!runs.isStreaming(run.id)) runs.connectLogs(run.id);
}

/**
 * Through the one confirm dialog rather than a `Dialog` of its own — which
 * `ConfirmDialog`'s docblock says was *copied from here*, so the two could
 * only ever drift apart.
 */
async function remove(run: RunRecord) {
  const ok = await useConfirmStore().ask({
    title: "Delete this run?",
    message:
      "Its results, log and frozen configuration are removed from disk. This cannot be undone.",
    confirmLabel: "Delete",
    destructive: true,
  });
  if (ok) await attempt("Deleting the run", () => runs.remove(run.id));
}

/**
 * Opens a comparison, oldest side first.
 *
 * `a` is *before*, so two runs are ordered by when they were made and a run
 * against the working tree puts the run on the left: the question is almost
 * always "what has changed since", not "what did it used to be".
 */
function compareWith(run: RunRecord, other: CompareRef) {
  const mine = runRef(run.id);
  if (other.kind === "run") {
    const older =
      (runs.get(other.runId)?.created_at ?? "") < run.created_at ? other : mine;
    const newer = older === mine ? other : mine;
    tabs.openCompare(older, newer);
    return;
  }
  tabs.openCompare(mine, other);
}

/**
 * What a scenario does to the model, with no run involved.
 *
 * The same view with the same folder on both sides: nothing about a comparison
 * requires two *versions*, and "what does high_cost actually change?" is a
 * question people ask of a model they have not solved yet.
 */
function compareScenarios() {
  tabs.openCompare(workspaceRef(), workspaceRef(runs.scenario));
}

function rename(run: RunRecord, label: string) {
  void attempt("Renaming the run", () => runs.rename(run.id, label));
}

function cancel(run: RunRecord) {
  void attempt("Cancelling the run", () => runs.cancel(run.id));
}

function refresh() {
  if (tabs.versionId) runs.load(tabs.versionId);
}

function setRetention(keep: number | null) {
  if (!tabs.versionId) return;
  void attempt("Changing run retention", () => runs.setRetention(tabs.versionId!, keep));
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PanelHeader>
      <!-- The trigger is the wrapper, not the button: a disabled control fires
           no pointer events, so a tooltip on one never opens. It only takes the
           button's place in the tab order while the button is out of it. -->
      <InfoTip :label="runTip">
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

      <!-- One pill with its word for one run; a dot per run when there are
           several, since the strip is 200px at its narrowest and the list
           below carries the words. `active[0]` alone said nothing about the
           second run. -->
      <RunStatusPill
        v-for="run in runs.active"
        :key="run.id"
        :status="run.status"
        :dot-only="busy && runs.active.length > 1"
      />

      <div class="flex-1" />
      <TooltipButton
        v-if="runs.hasScenarios"
        label="Compare a scenario against the model as written."
        :icon="GitCompare"
        testid="compare-scenarios"
        @click="compareScenarios"
      />
      <TooltipButton label="Reload the run history." :icon="RefreshCw" @click="refresh" />
    </PanelHeader>

    <!-- Its own strip rather than a control in the header above: the sidebar
         narrows to around 200px, that header already holds a button, a status
         pill and an icon button, and a scenario name is as long as the user
         made it. Absent entirely for a model that defines neither scenarios nor
         overrides, which is also every viewer-mode session. -->
    <PanelHeader v-if="runs.hasScenarios" data-testid="scenario-strip">
      <span :class="cn('shrink-0', FIELD_LABEL)">Scenario</span>
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
                <Badge variant="outline" :class="WARNING_BADGE">
                  {{ formatCount(entry.missing.length, "unknown override") }}
                </Badge>
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
      <StateMessage
        v-if="actionError"
        variant="inline"
        tone="danger"
        data-testid="run-action-error"
      >
        {{ actionError }}
      </StateMessage>
      <StateMessage v-if="runs.error" variant="inline" tone="danger">
        {{ runs.error }}
      </StateMessage>

      <RunListItem
        v-for="run in runs.ordered"
        :key="run.id"
        :run="run"
        :active="run.id === activeRunId"
        :others="runs.ordered"
        @open="open(run, $event)"
        @rename="rename(run, $event)"
        @cancel="cancel(run)"
        @remove="remove(run)"
        @compare="compareWith(run, $event)"
      />

      <!-- Not while loading: "No runs yet" over a history still on its way is
           a false statement for as long as the request takes. -->
      <StateMessage
        v-if="runs.isLoading && !runs.ordered.length"
        variant="inline"
        loading
        data-testid="run-list-loading"
      >
        Reading the run history…
      </StateMessage>
      <StateMessage
        v-else-if="!runs.ordered.length && !runs.error"
        variant="inline"
      >
        No runs yet. Solving writes results beside the model, in
        <code :class="IDENTIFIER">calliope-studio/runs/</code>.
      </StateMessage>
    </div>

    <!-- What the history costs, and how much of it is kept. Visible because the
         directory is visible: a user told to look in `calliope-studio/` needs to know
         both what it is costing and why old runs disappear. -->
    <PanelFooter v-if="tabs.versionId">
      <HardDrive class="size-3" />
      <span>{{ formatCount(runs.ordered.length, "run") }}</span>
      <span class="tabular-nums">· {{ formatBytes(runs.totalBytes) }}</span>

      <div class="flex-1" />

      <!-- The tooltip wraps the *whole* menu, not its trigger. See `RunListItem`
           for why: a `Tooltip` between a `DropdownMenu` and its trigger shadows
           the popper context the trigger registers its anchor into. -->
      <InfoTip label="How many finished runs to keep. Applied the next time a run starts.">
        <span class="inline-flex">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button type="button" data-testid="retention" :class="TEXT_BUTTON_SM">
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
  </div>
</template>
