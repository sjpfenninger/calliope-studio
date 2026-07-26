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

import RunStatusPill from "./RunStatusPill.vue";
import { formatDuration, formatObjective, formatTimestamp } from "@/lib/format";
import { ICON_STROKE_WIDTH } from "@/lib/icons";
import { isTerminal, useRunsStore } from "@/stores/runs";

const props = defineProps<{ runId: string }>();

const runs = useRunsStore();

const viewport = ref<HTMLElement | null>(null);
const pinned = ref(true);

const run = computed(() => runs.get(props.runId));
const lines = computed(() => runs.logsFor(props.runId));
const stage = computed(() => runs.stages.get(props.runId));
const running = computed(() => (run.value ? !isTerminal(run.value.status) : false));

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
      <span v-if="stage && running" class="text-2xs text-text-faint">
        {{ stage.name }} · {{ stage.status }}
      </span>

      <div class="flex-1" />

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
      <p v-for="(line, index) in lines" :key="index" class="whitespace-pre-wrap">
        {{ line }}
      </p>

      <p v-if="!lines.length" class="text-sm text-muted-foreground">
        {{ running ? "Waiting for the worker…" : "This run produced no log output." }}
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
