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
import { Square } from "lucide-vue-next";

import RunProgress from "./RunProgress.vue";
import RunStatusPill from "./RunStatusPill.vue";
import { cn } from "@/lib/utils";
import { formatDuration, formatObjective, formatTimestamp } from "@/lib/format";
import { FIELD } from "@/lib/formClasses";
import { ICON_STROKE_WIDTH } from "@/lib/icons";
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
  INFO: "text-text",
  WARNING: "text-warning-text",
  ERROR: "text-danger-text",
  CRITICAL: "text-danger-text",
};

function styleFor(line: LogLine): string {
  return LEVEL_STYLE[line.level] ?? "text-text";
}

const FILTERS: Array<{ id: LogFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "info", label: "No solver output" },
  { id: "errors", label: "Errors only" },
];

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
    <header
      class="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-panel px-2"
    >
      <RunStatusPill v-if="run" :status="run.status" />
      <RunProgress :stage="stage" :running="running" />

      <div class="min-w-2 flex-1" />

      <select
        v-model="runs.logFilter"
        data-testid="log-filter"
        aria-label="Log detail"
        :class="cn(FIELD, 'h-5 w-auto py-0 text-2xs text-text-dim')"
      >
        <option v-for="option in FILTERS" :key="option.id" :value="option.id">
          {{ option.label }}
        </option>
      </select>

      <span v-if="run?.solver" class="text-2xs text-text-faint">{{ run.solver }}</span>
      <span v-if="run?.objective != null" class="text-2xs tabular-nums text-text-faint">
        objective {{ formatObjective(run.objective) }}
      </span>
      <span
        v-if="run?.duration_seconds != null"
        class="text-2xs tabular-nums text-text-faint"
      >
        {{ formatDuration(run.duration_seconds) }}
      </span>

      <button
        v-if="running"
        type="button"
        data-testid="cancel-run"
        class="inline-flex h-5 items-center gap-1 rounded-xs border border-border px-1.5 text-2xs hover:bg-hover"
        @click="runs.cancel(runId)"
      >
        <Square class="size-2.5" :stroke-width="ICON_STROKE_WIDTH" />
        Cancel
      </button>
    </header>

    <div
      ref="viewport"
      class="min-h-0 flex-1 overflow-auto bg-surface p-2 font-mono text-xs leading-4"
      @scroll="onScroll"
    >
      <p v-if="trimmed" class="mb-1 text-2xs text-text-faint">
        {{ trimmed.toLocaleString() }} earlier lines trimmed — all of them are in
        <code>run.log</code>.
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

      <p v-if="!lines.length" class="text-sm text-muted-foreground">
        <template v-if="running">Waiting for the worker…</template>
        <template v-else-if="runs.logFilter !== 'all'">
          Nothing at this level. The whole log is under “All”.
        </template>
        <template v-else>This run produced no log output.</template>
      </p>

      <!-- The error is in `outcome.json` rather than in the stream when the
           worker died before it could log anything. -->
      <p v-if="run?.error" class="mt-2 whitespace-pre-wrap text-danger-text">
        {{ run.error }}
      </p>
      <details v-if="run?.traceback" class="mt-2">
        <summary class="cursor-pointer text-2xs text-text-faint">Traceback</summary>
        <pre class="mt-1 whitespace-pre-wrap text-2xs text-text-dim">{{
          run.traceback
        }}</pre>
      </details>
    </div>

    <footer
      v-if="run"
      class="flex h-6 shrink-0 items-center gap-2 border-t border-border px-2 text-2xs text-text-faint"
    >
      <span :title="run.id">{{ run.id.slice(0, 8) }}</span>
      <span v-if="run.scenario">· {{ run.scenario }}</span>
      <span v-if="run.solved_from">· solved from {{ run.solved_from }}</span>
      <div class="flex-1" />
      <span>{{ formatTimestamp(run.started_at ?? run.created_at) }}</span>
    </footer>
  </div>
</template>
