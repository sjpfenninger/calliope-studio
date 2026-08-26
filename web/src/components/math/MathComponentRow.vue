<script setup lang="ts">
/**
 * One component in the Math tab's list.
 *
 * A component rather than markup repeated twice, because the list now draws it
 * in two places — what the model formulates, and what its math switches off —
 * and the two must not drift into different rows.
 *
 * Selection keys on group *and* name. A name alone is not unique: a dispatch
 * model declares `flow_cap` as a parameter and deactivates the base-math
 * variable of the same name, so two rows are called `flow_cap` and only one of
 * them is the one that was clicked.
 */
import { computed } from "vue";

import { Badge } from "@/components/ui/badge";
import { WARNING_BADGE } from "@/lib/formClasses";
import { componentKey, useMathStore } from "@/stores/math";
import type { MathComponent } from "@/api/versions";

const props = defineProps<{
  component: MathComponent;
  /** Whether it comes from a math file in this workspace. */
  mine: boolean;
}>();

const math = useMathStore();

const key = computed(() => componentKey(props.component));
const isSelected = computed(() => key.value === math.selectedKey);

/**
 * Deactivated rows are muted rather than badged.
 *
 * They sit under their own heading, so a badge on each would repeat what the
 * heading above them already says, in the densest part of the app.
 */
const tone = computed(() => {
  if (isSelected.value) return "bg-accent-soft text-accent-text";
  if (props.component.deactivated) return "text-text-muted hover:bg-hover";
  return "text-foreground hover:bg-hover";
});
</script>

<template>
  <button
    type="button"
    class="flex w-full items-center gap-1 px-2 py-0.5 text-left text-sm"
    :class="tone"
    :data-math-component="component.name"
    @click="math.select(key)"
  >
    <span class="truncate text-sm">{{ component.name }}</span>
    <span class="flex-1" />
    <Badge
      v-if="component.overridden"
      variant="outline"
      :class="WARNING_BADGE"
      data-testid="math-overridden"
    >
      {{ component.deactivated ? "switched off" : "override" }}
    </Badge>
    <Badge
      v-else-if="mine"
      variant="outline"
      class="shrink-0 border-accent-border px-1 font-normal text-accent-text"
    >
      mine
    </Badge>
  </button>
</template>
