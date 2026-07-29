<script setup lang="ts">
/**
 * Which Calliope schema the open file is checked against, and a way to say
 * otherwise.
 *
 * Detection is the server's, and it is right about a finished model: a file is
 * a model definition if an `import:` chain reaches it, and math if
 * `config.init.math_paths` names it. An editor is where a model is *not*
 * finished, though, and a file nothing refers to yet is detected as nothing at
 * all. Rather than guess — guessing wrong lights a valid file up red — the kind
 * is shown, and the user can correct it.
 *
 * Shown only for a real file. A section or entry tab is a fragment of a model
 * definition by construction, so there is nothing to choose.
 */
import { computed } from "vue";
import { RotateCcw } from "@lucide/vue";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import InfoTip from "@/components/app/InfoTip.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import type { FileKind } from "@/lib/calliopeSchema";
import { useSchemaKindsStore } from "@/stores/schemaKinds";

const props = defineProps<{ path: string }>();

const schemaKinds = useSchemaKindsStore();

const LABELS: Record<FileKind, string> = {
  model: "Model definition",
  math: "Math",
  unknown: "No schema",
};

const kind = computed(() => schemaKinds.kindOf(props.path));
const overridden = computed(() => schemaKinds.isOverridden(props.path));

function choose(value: unknown) {
  schemaKinds.override(props.path, value as FileKind);
}
</script>

<template>
  <div class="flex items-center gap-1" data-testid="schema-kind">
    <span class="text-2xs text-text-faint">Schema</span>
    <Select :model-value="kind" @update:model-value="choose">
      <!-- The tooltip wraps the trigger rather than the other way round: each
           `as-child` merges down onto the one real button, so the order decides
           which primitive owns it. -->
      <InfoTip
        :label="
          overridden
            ? 'You chose this. Reset to use what the model says.'
            : 'Detected from how the model refers to this file'
        "
      >
        <SelectTrigger
          size="sm"
          class="min-w-0"
          aria-label="Which Calliope schema checks this file"
          data-testid="schema-kind-trigger"
        >
          <SelectValue>{{ LABELS[kind] }}</SelectValue>
        </SelectTrigger>
      </InfoTip>
      <SelectContent>
        <SelectItem value="model">{{ LABELS.model }}</SelectItem>
        <SelectItem value="math">{{ LABELS.math }}</SelectItem>
        <SelectItem value="unknown">{{ LABELS.unknown }}</SelectItem>
      </SelectContent>
    </Select>
    <TooltipButton
      v-if="overridden"
      label="Use the detected schema again"
      :icon="RotateCcw"
      size="xs"
      testid="schema-kind-reset"
      @click="schemaKinds.clearOverride(props.path)"
    />
  </div>
</template>
