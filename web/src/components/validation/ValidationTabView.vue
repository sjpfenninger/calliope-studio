<script setup lang="ts">
/**
 * Validation results, as a tab.
 *
 * They used to be a list wedged under the model tree, which meant they vanished
 * the moment the user went to Files or Runs — and going to Files is exactly what
 * you do about a validation error. Only the sidebar badge survived, saying a
 * number with no way to see what it counted.
 *
 * A tab also gives the build tier somewhere to *be* while it runs. It takes
 * seconds to minutes and previously showed nothing at all: no spinner, no
 * disabled button, no way to stop it.
 *
 * Clicking a problem opens its file as a **preview** (`tabs.jumpTo`), so working
 * down a list of twelve reuses one editor tab instead of opening twelve.
 */
import { computed } from "vue";
import { CircleCheck, CircleX, ShieldCheck, Square, TriangleAlert } from "@lucide/vue";

import InfoTip from "@/components/app/InfoTip.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import { Badge } from "@/components/ui/badge";
import { formatCount, formatRelativeTime, formatTimestamp } from "@/lib/format";
import { GHOST_BUTTON, SECONDARY_BUTTON } from "@/lib/formClasses";
import { useTabsStore } from "@/stores/tabs";
import { useValidationStore, type ValidationProblem } from "@/stores/validation";

const tabs = useTabsStore();
const validation = useValidationStore();

const running = computed(
  () => validation.phase === "syntax" || validation.phase === "build",
);

const status = computed(() => {
  if (validation.phase === "syntax") return "Checking syntax…";
  if (validation.phase === "build") return "Asking Calliope to build the model…";
  if (validation.phase === "idle") return "Not yet validated";
  return validation.problems.length
    ? formatCount(validation.problems.length, "problem")
    : "No problems found";
});

/** Only the syntax tier locates a problem, so only it can be navigated to. */
function locatable(problem: ValidationProblem): boolean {
  return problem.line != null;
}

function open(problem: ValidationProblem) {
  if (problem.line != null) tabs.jumpTo(problem.file, problem.line, 1);
}

function revalidate() {
  if (tabs.versionId) validation.validate(tabs.versionId);
}

/**
 * When it was last checked, as an ISO string for `format.ts`'s pair: the
 * relative form on screen, the full one in the tooltip. The store keeps a
 * number because that is what `Date.now()` hands it.
 */
const validatedAt = computed(() =>
  validation.lastValidatedAt ? new Date(validation.lastValidatedAt).toISOString() : null,
);

/**
 * A warning and an error are painted apart, because `severity` arrived on
 * every problem and was read by nothing — a model that merely warned looked
 * exactly like one that would not build.
 */
const SEVERITY = {
  error: { glyph: CircleX, tone: "text-danger-text" },
  warning: { glyph: TriangleAlert, tone: "text-warning-text" },
} as const;
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="validation-tab">
    <PanelHeader tone="surface">
      <span class="text-sm" data-testid="validation-status">{{ status }}</span>
      <InfoTip v-if="validatedAt && !running" :label="formatTimestamp(validatedAt)">
        <span class="text-sm text-text-muted" data-testid="validation-when">
          {{ formatRelativeTime(validatedAt) }}
        </span>
      </InfoTip>

      <div class="flex-1" />

      <button
        v-if="running"
        type="button"
        data-testid="validation-cancel"
        :class="SECONDARY_BUTTON"
        @click="validation.cancel()"
      >
        <Square class="size-3.5" />
        Cancel validation
      </button>
      <button
        v-else
        type="button"
        data-testid="validation-revalidate"
        :class="GHOST_BUTTON"
        :disabled="!tabs.versionId"
        @click="revalidate"
      >
        <ShieldCheck class="size-3.5" />
        Validate again
      </button>
    </PanelHeader>

    <StateMessage v-if="validation.error" variant="fill" tone="danger">
      {{ validation.error }}
    </StateMessage>

    <StateMessage
      v-else-if="running && !validation.problems.length"
      variant="fill"
      loading
    >
      {{
        validation.phase === "build"
          ? "Calliope is building the model. This can take a while on a large one."
          : "Parsing every YAML file in the model."
      }}
    </StateMessage>

    <StateMessage
      v-else-if="validation.phase === 'idle'"
      variant="fill"
      :icon="ShieldCheck"
    >
      Press Validate to check this model.
    </StateMessage>

    <!-- design-check: allow native-title — `StateMessage`'s `title` is a prop. -->
    <StateMessage
      v-else-if="!validation.problems.length"
      variant="fill"
      :icon="CircleCheck"
      title="No problems found"
    >
      The YAML parses and Calliope built the model.
    </StateMessage>

    <div v-else class="min-h-0 flex-1 overflow-auto" data-testid="validation-errors">
      <component
        :is="locatable(problem) ? 'button' : 'div'"
        v-for="(problem, index) in validation.problems"
        :key="index"
        :type="locatable(problem) ? 'button' : undefined"
        data-testid="validation-problem"
        :data-tier="problem.tier"
        :data-severity="problem.severity"
        :data-file="problem.file"
        :data-line="problem.line ?? undefined"
        class="flex w-full flex-col items-start gap-0.5 border-b border-border-subtle px-2 py-1 text-left"
        :class="locatable(problem) && 'hover:bg-hover'"
        @click="open(problem)"
      >
        <span class="flex w-full items-center gap-1 text-sm text-text-muted">
          <span class="truncate">{{ problem.file }}</span>
          <span v-if="problem.line != null">:{{ problem.line }}</span>
          <Badge variant="outline" class="ml-auto">{{ problem.tier }}</Badge>
        </span>
        <span class="flex items-start gap-1.5 text-sm" :class="SEVERITY[problem.severity].tone">
          <component :is="SEVERITY[problem.severity].glyph" class="mt-0.5 size-3.5 shrink-0" />
          <span>{{ problem.message }}</span>
        </span>
      </component>

      <!-- The build tier reports no line numbers, so its rows do not navigate.
           Said once, here, rather than left to look like a broken click. -->
      <StateMessage
        v-if="validation.problems.some((problem) => !locatable(problem))"
        variant="note"
        class="px-2 py-1"
      >
        Calliope does not report line numbers, so build problems cannot be jumped
        to.
      </StateMessage>

      <StateMessage v-if="running" variant="inline" loading>
        Still working…
      </StateMessage>
    </div>
  </div>
</template>
