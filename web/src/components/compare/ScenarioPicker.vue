<script setup lang="ts">
/**
 * Which scenario one side of a comparison is read under.
 *
 * One component for both sides, so the two cannot end up offering different
 * things. Only a workspace side has a scenario to choose: a run's is a fact
 * about what it solved, and offering to change it would present something that
 * never ran as though it had.
 */
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRunsStore } from "@/stores/runs";

const props = defineProps<{
  scenario: string | null;
  testid: string;
  label: string;
}>();

const emit = defineEmits<{ "update:scenario": [string | null] }>();

const runs = useRunsStore();

/**
 * The sentinel for "no scenario", because a `Select` cannot bind to null.
 *
 * The same spelling `RunsSection` uses, and for the same reason: no Calliope
 * scenario is called this.
 */
const NONE = "__none__";

/**
 * A scenario name containing `:` cannot be a compare tab: `lib/tabId.ts`
 * splits ids on it, so the tab would open and work and then vanish on
 * reload, since `?tab=` could never name it again. Offered disabled rather
 * than hidden, so the model's own list still reads complete.
 */
const offerable = (name: string) => !name.includes(":");

function choose(value: unknown) {
  const name = String(value ?? NONE);
  emit("update:scenario", name === NONE ? null : name);
}
</script>

<template>
  <Select :model-value="props.scenario ?? NONE" @update:model-value="choose">
    <SelectTrigger size="sm" class="min-w-0 max-w-48" :aria-label="props.label" :data-testid="props.testid">
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
          :disabled="!offerable(entry.name)"
        >
          {{ entry.name }}
        </SelectItem>
      </SelectGroup>

      <!-- Offered because `scenario=` takes either: a scenario name, or a
           joined list of override names. Most models define more of the latter. -->
      <SelectGroup v-if="runs.scenarios.overrides.length">
        <SelectLabel>Overrides</SelectLabel>
        <SelectItem
          v-for="entry in runs.scenarios.overrides"
          :key="entry.name"
          :value="entry.name"
          :disabled="!offerable(entry.name)"
        >
          {{ entry.name }}
        </SelectItem>
      </SelectGroup>
    </SelectContent>
  </Select>
</template>
