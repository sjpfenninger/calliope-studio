<script setup lang="ts">
/**
 * How far through a run is, as the stages Calliope reports passing.
 *
 * The log header used to say `{{ stage.name }} · {{ stage.status }}` and, for
 * want of the right key, rendered "undefined · start". Even had it worked, the
 * run's coarse stages hid the only thing worth watching: `solve` covered the
 * solver *and* postprocessing, so the longest part of a long run reported one
 * word for minutes at a time.
 *
 * A stage the run passed through without entering — `build` and `solve` on a
 * resolution — is dimmed rather than left looking pending: it is not going to
 * happen, and a strip that waits for it for ever reads as stuck.
 */
import { computed } from "vue";
import InfoTip from "@/components/app/InfoTip.vue";

import { RUN_STAGES, type RunStage } from "@/stores/runs";

const props = defineProps<{
  stage: RunStage | undefined;
  /** Whether the run is still going. A finished one shows no active segment. */
  running: boolean;
}>();

/** How each stage reads, once. `postprocess` is too long for the space. */
const LABELS: Record<string, string> = {
  preprocess: "Preprocess",
  build: "Build",
  solve: "Solve",
  postprocess: "Postprocess",
  save: "Save",
};

type Segment = { name: string; label: string; state: "done" | "active" | "waiting" };

const current = computed(() => props.stage?.name ?? null);

const segments = computed<Segment[]>(() => {
  const reached = current.value ? RUN_STAGES.indexOf(current.value as never) : -1;
  const finished = props.stage?.status === "done";

  return RUN_STAGES.map((name, index) => {
    let state: Segment["state"] = "waiting";
    if (index < reached || (index === reached && finished)) state = "done";
    else if (index === reached) state = "active";
    return { name, label: LABELS[name] ?? name, state };
  });
});

// `done` is green because the status pill beside this strip paints a finished
// run green: with the segments in accent, a run that had just succeeded showed
// two colours for one fact. Accent stays on the segment that is *in progress*,
// which is what accent means on the pill too (`running`). A completed stage of
// a run that later failed keeps its green — that stage did finish, and the pill
// is what says how the run as a whole ended.
const SEGMENT_STYLE: Record<Segment["state"], string> = {
  done: "bg-success",
  active: "bg-primary animate-pulse",
  waiting: "bg-border-strong",
};
</script>

<template>
  <div
    v-if="stage"
    data-testid="run-progress"
    :data-stage="current"
    :data-status="stage.status"
    class="flex min-w-0 items-center gap-1.5"
  >
    <!-- Only the segments say anything: the current stage is spelled out in
         words immediately to the right, so the strip as a whole had nothing to
         add that was not already on screen. -->
    <div class="flex items-center gap-0.5">
      <InfoTip v-for="segment in segments" :key="segment.name" :label="segment.label">
        <span
          :data-segment="segment.name"
          :data-state="segment.state"
          class="h-1 w-4 rounded-full"
          :class="SEGMENT_STYLE[segment.state]"
        />
      </InfoTip>
    </div>

    <span class="shrink-0 text-2xs text-text-dim">
      {{ LABELS[current ?? ""] ?? current }}
    </span>
    <span
      v-if="stage.detail && running"
      data-testid="run-progress-detail"
      class="truncate text-2xs text-text-muted"
    >
      {{ stage.detail }}
    </span>
  </div>
</template>
