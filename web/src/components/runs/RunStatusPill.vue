<script setup lang="ts">
/**
 * A run's status, as a dot and a word.
 *
 * One component rather than a class map repeated in the list, the tab body and
 * the log header — a status that is amber in one place and red in another is
 * worse than no colour at all.
 *
 * `infeasible` is amber, not red: the worker treats it as a legitimate outcome —
 * the model solved and was found infeasible — so painting it as a failure tells
 * the user their software broke when their model is what needs attention.
 */
import InfoTip from "@/components/app/InfoTip.vue";
import type { RunStatus } from "@/stores/runs";

withDefaults(
  defineProps<{
    status: RunStatus;
    /** Just the dot, for places with no room for a word. */
    dotOnly?: boolean;
  }>(),
  { dotOnly: false },
);

// Fills are the `*-soft` tokens throughout. The neutral statuses used to reach
// for `bg-muted`, which is `--cg-surface-2` — a *surface*, and one step from the
// panel it sits on, so the pill all but vanished against chrome.
const STATUS_STYLE: Record<RunStatus, string> = {
  pending: "border-border bg-surface-2 text-text-dim",
  running: "border-accent-border bg-accent-soft text-accent-text",
  success: "border-success-soft bg-success-soft text-success-text",
  infeasible: "border-warning-soft bg-warning-soft text-warning-text",
  failed: "border-danger-soft bg-danger-soft text-danger-text",
  cancelled: "border-border bg-surface-2 text-text-dim line-through decoration-1",
};

// `bg-border-strong`, not `bg-text-faint`: a text token has no business being a
// fill, and this is a neutral *mark* rather than de-emphasised writing.
const STATUS_DOT: Record<RunStatus, string> = {
  pending: "bg-border-strong",
  running: "bg-primary animate-pulse",
  success: "bg-success",
  infeasible: "bg-warning",
  failed: "bg-danger",
  cancelled: "bg-border-strong",
};
</script>

<template>
  <!-- Only the dot form needs saying: the other one prints the word. -->
  <InfoTip v-if="dotOnly" :label="status">
    <span
      data-testid="run-status"
      :data-status="status"
      class="size-1.5 shrink-0 rounded-full"
      :class="STATUS_DOT[status]"
    />
  </InfoTip>
  <span
    v-else
    data-testid="run-status"
    :data-status="status"
    class="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-xs border px-1.5 text-2xs font-medium capitalize"
    :class="STATUS_STYLE[status]"
  >
    <span class="size-1.5 rounded-full" :class="STATUS_DOT[status]" />
    {{ status }}
  </span>
</template>
