<script setup lang="ts">
/**
 * Which source the Math tab's list is narrowed to.
 *
 * The store keeps two fields — a source name and a "mine" flag — because the
 * Model tree sets the first without knowing about the second. Here they are one
 * choice, so one control: a `Segmented` in value mode, which is what every
 * other set-a-value strip in the app is. It used to be three hand-rolled runs of
 * chips at a height and radius nothing else had.
 *
 * Only *applied* sources are offered: an unapplied file contributes nothing to
 * the rendered formulation, so filtering to it would show an empty list and
 * read as a broken filter rather than as the point being made. The files panel
 * is where an unapplied file is dealt with. With one source and no user math
 * there is nothing to choose between, and the strip is not drawn.
 */
import { computed } from "vue";

import Eyebrow from "@/components/app/Eyebrow.vue";
import Segmented, { type SegmentItem } from "@/components/app/Segmented.vue";
import MathRailSection from "@/components/math/MathRailSection.vue";
import { useMathStore } from "@/stores/math";

const math = useMathStore();

const applied = computed(() => math.sources.filter((source) => source.applied));

const hasUserMath = computed(() =>
  math.sources.some((source) => source.kind === "user" && source.applied),
);

const shown = computed(() => applied.value.length > 1 || hasUserMath.value);

// Prefixed, so a user math file called `all` or `mine` cannot collide with the
// two fixed segments.
const ALL = "all";
const MINE = "mine";
const sourceValue = (name: string) => `source:${name}`;

const items = computed<SegmentItem<string>[]>(() => [
  { value: ALL, label: "All" },
  ...(hasUserMath.value ? [{ value: MINE, label: "Mine", testid: "math-user-only" }] : []),
  ...applied.value.map((source) => ({ value: sourceValue(source.name), label: source.name })),
]);

const choice = computed({
  get: () =>
    math.userOnly ? MINE : math.sourceFilter ? sourceValue(math.sourceFilter) : ALL,
  set: (value: string | undefined) => {
    if (value === undefined) return;
    if (value === MINE) {
      math.sourceFilter = null;
      math.userOnly = true;
      return;
    }
    math.focusSource(value === ALL ? null : value.slice("source:".length));
  },
});
</script>

<template>
  <MathRailSection v-if="shown">
    <Eyebrow>Source</Eyebrow>
    <!-- Wrapping, because a model may apply more files than a 224px rail holds
         on one line, and a filter that scrolls sideways is one nobody finds the
         end of. -->
    <Segmented
      v-model="choice"
      :items="items"
      mode="value"
      size="md"
      class="flex-wrap"
      data-testid="math-source-filter"
    />
  </MathRailSection>
</template>
