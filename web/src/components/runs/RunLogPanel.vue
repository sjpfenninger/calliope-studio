<script setup lang="ts">
/**
 * A run's log, live while it is solving.
 *
 * This is what a run tab opens on, because at that moment it is the only thing
 * there is to show. The loop it completes did not exist before: click Run, the
 * tab opens here, lines stream, and the tab moves itself to the charts when
 * results appear.
 *
 * Autoscroll follows only while the user is already at the bottom. Yanking the
 * viewport back down while someone is reading a traceback is the classic way to
 * make a live log unusable.
 */
import { computed, nextTick, ref, watch } from "vue";
import Metric from "@/components/app/Metric.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import PanelFooter from "@/components/app/PanelFooter.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import { Square } from "@lucide/vue";

import RunProgress from "./RunProgress.vue";
import RunStatusPill from "./RunStatusPill.vue";
import { errorDetail } from "@/api/errors";
import { cn } from "@/lib/utils";
import {
  formatCount,
  formatDuration,
  formatObjective,
  formatTimestamp,
} from "@/lib/format";
import {
  CODE_BLOCK,
  CODE_WELL,
  FIELD_SM,
  IDENTIFIER,
  SECONDARY_BUTTON_SM,
} from "@/lib/formClasses";

import {
  isTerminal,
  passesFilter,
  useRunsStore,
  type LogFilter,
  type LogLine,
} from "@/stores/runs";

const props = defineProps<{ runId: string }>();

const runs = useRunsStore();

const viewport = ref<HTMLElement | null>(null);
const pinned = ref(true);

const run = computed(() => runs.get(props.runId));
const lines = computed(() =>
  runs.logsFor(props.runId).filter((line) => passesFilter(line, runs.logFilter)),
);
const trimmed = computed(() => runs.trimmedFor(props.runId));
const stage = computed(() => runs.stages.get(props.runId));
const running = computed(() => (run.value ? !isTerminal(run.value.status) : false));

/**
 * How a line is coloured.
 *
 * The level used to be thrown away on the wire, so every line — a solver's
 * iteration count, a deprecation warning, the exception that ended the run —
 * rendered identically. Solver output is DEBUG and deliberately recedes: it is
 * the bulk of a long run's log and the least of what a reader is looking for.
 */
const LEVEL_STYLE: Record<string, string> = {
  DEBUG: "text-text-dim",
  INFO: "text-foreground",
  WARNING: "text-warning-text",
  ERROR: "text-danger-text",
  CRITICAL: "text-danger-text",
};

function styleFor(line: LogLine): string {
  return LEVEL_STYLE[line.level] ?? "text-foreground";
}

const FILTERS: Array<{ id: LogFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "info", label: "No solver output" },
  { id: "errors", label: "Errors only" },
];

/**
 * A failed cancel leaves the run visibly still solving, which without a
 * message reads as the button doing nothing.
 *
 * Local, rather than the runs section's `actionError`: this panel lives in the
 * run tab, and the section that owns that surface may not be on screen.
 */
const cancelError = ref<string | null>(null);

async function cancel() {
  cancelError.value = null;
  try {
    await runs.cancel(props.runId);
  } catch (caught) {
    cancelError.value = errorDetail(caught, "Cancelling the run failed.");
  }
}

function onScroll() {
  const element = viewport.value;
  if (!element) return;
  // A few pixels of slack: a smooth-scrolled viewport rarely lands exactly on
  // its own scrollHeight.
  pinned.value =
    element.scrollHeight - element.scrollTop - element.clientHeight < 24;
}

watch(
  () => lines.value.length,
  async () => {
    if (!pinned.value) return;
    await nextTick();
    const element = viewport.value;
    if (element) element.scrollTop = element.scrollHeight;
  },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="run-log">
    <PanelHeader size="md">
      <RunStatusPill v-if="run" :status="run.status" />
      <RunProgress :stage="stage" :running="running" />

      <div class="min-w-2 flex-1" />

      <select
        v-model="runs.logFilter"
        data-testid="log-filter"
        aria-label="Log detail"
        :class="cn(FIELD_SM, 'w-auto text-text-dim')"
      >
        <option v-for="option in FILTERS" :key="option.id" :value="option.id">
          {{ option.label }}
        </option>
      </select>

      <span v-if="run?.solver" class="text-2xs text-text-muted">{{ run.solver }}</span>
      <!-- The same `Metric` the run list uses, so the objective here and the one
           in the row that opened this tab cannot be two tones of one number. -->
      <Metric
        v-if="run?.objective != null"
        layout="inline"
        label="objective"
        :value="formatObjective(run.objective)"
      />
      <Metric
        v-if="run?.duration_seconds != null"
        layout="inline"
        label="took"
        :value="formatDuration(run.duration_seconds)"
      />

      <button
        v-if="running"
        type="button"
        data-testid="cancel-run"
        :class="SECONDARY_BUTTON_SM"
        @click="cancel"
      >
        <Square class="size-3" />
        Cancel run
      </button>
    </PanelHeader>

    <StateMessage v-if="cancelError" variant="note" tone="danger" class="px-2 py-1">
      {{ cancelError }}
    </StateMessage>

    <!-- `bg-surface` because this *is* the pane, the way Monaco's editor is: a
         log is the content of the tab, not a well set into it. `CODE_WELL` is
         for the traceback below, which is a box inside this one. -->
    <div
      ref="viewport"
      class="min-h-0 flex-1 overflow-auto bg-surface p-2"
      :class="CODE_BLOCK"
      @scroll="onScroll"
    >
      <p v-if="trimmed" class="mb-1 text-sm text-text-muted">
        {{ formatCount(trimmed, "earlier line") }} trimmed — all of them are in
        <code :class="IDENTIFIER">run.log</code>.
      </p>

      <p
        v-for="(line, index) in lines"
        :key="index"
        :data-level="line.level"
        class="whitespace-pre-wrap"
        :class="styleFor(line)"
      >
        {{ line.text }}
      </p>

      <StateMessage v-if="!lines.length" variant="inline">
        <template v-if="running">Waiting for the worker…</template>
        <template v-else-if="runs.logFilter !== 'all'">
          Nothing at this level. The whole log is under “All”.
        </template>
        <template v-else>This run produced no log output.</template>
      </StateMessage>

      <!-- The error is in `outcome.json` rather than in the stream when the
           worker died before it could log anything. -->
      <p v-if="run?.error" class="mt-2 whitespace-pre-wrap text-danger-text">
        {{ run.error }}
      </p>
      <details v-if="run?.traceback" class="mt-2">
        <summary class="cursor-pointer text-sm text-text-muted">Traceback</summary>
        <pre
          class="mt-1 whitespace-pre-wrap text-text-dim"
          :class="[CODE_WELL, CODE_BLOCK]"
        >{{ run.traceback }}</pre>
      </details>
    </div>

    <PanelFooter v-if="run">
      <!-- design-check: allow native-title — the id, of which the eight
           characters beside it are the visible prefix. -->
      <span :title="run.id">{{ run.id.slice(0, 8) }}</span>
      <span v-if="run.scenario">· {{ run.scenario }}</span>
      <!-- Only the fallback is worth saying. Every run is frozen and a model
           that refers to nothing outside its own folder always solves from that
           freeze, so "solved from snapshot" appeared on essentially every run
           and carried no information. The other value means the snapshot was
           not buildable and the live tree was solved instead, which is the one
           case where "as written" and "as solved" can differ. -->
      <span v-if="run.solved_from === 'workspace'" class="text-warning-text">
        · solved from the live workspace, not the frozen snapshot
      </span>
      <div class="flex-1" />
      <span>{{ formatTimestamp(run.started_at ?? run.created_at) }}</span>
    </PanelFooter>
  </div>
</template>
