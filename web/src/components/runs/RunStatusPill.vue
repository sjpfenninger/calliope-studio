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
import type { RunStatus } from "@/stores/runs";

withDefaults(
  defineProps<{
    status: RunStatus;
    /** Just the dot, for places with no room for a word. */
    dotOnly?: boolean;
  }>(),
  { dotOnly: false },
);

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
</script>

<template>
  <span
    v-if="dotOnly"
    data-testid="run-status"
    :data-status="status"
    :title="status"
    class="size-1.5 shrink-0 rounded-full"
    :class="STATUS_DOT[status]"
  />
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
