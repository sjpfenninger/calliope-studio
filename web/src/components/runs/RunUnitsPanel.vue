<script setup lang="ts">
/**
 * What this model's quantities are really measured in.
 *
 * Calliope says `flow_out` is "energy" and stops there — nothing in a model
 * definition says whether that energy is kWh, MWh or GWh, so nothing but the
 * modeller can. This is where they say it, once per quantity, and every figure,
 * the table and every export follow.
 *
 * In the sidebar rather than a figure header for two reasons: a setting that
 * applies to all six figures does not belong in one of their headers, and those
 * headers are measured — their height is what a collapsed figure *is*, so a
 * control added there changes the layout of the panel it sits in.
 *
 * Only the quantities this model actually uses are offered. A model with no
 * transmission distances has no use for a distance setting, and an inapplicable
 * row is one more thing to read past.
 */
import { computed, inject } from "vue";

import { FIELD, SECTION_HEADING } from "@/lib/formClasses";
import { parseScale, quantitiesIn, type Quantity } from "@/lib/units";
import { RUN_SELECTION } from "@/stores/runSelection";
import { useUnitsStore } from "@/stores/units";

const store = inject(RUN_SELECTION)!;
const units = useUnitsStore();

const quantities = computed<Quantity[]>(() =>
  quantitiesIn(store.catalog?.variables.units ?? {}),
);

function scaleOf(quantity: Quantity): string {
  return units.prefs[quantity]?.scale ?? "";
}

function labelOf(quantity: Quantity): string {
  return units.prefs[quantity]?.label ?? "";
}

/**
 * A scale that cannot be read is shown as wrong and *not* applied.
 *
 * Half-typed is the normal state of a field: `1e` is on the way to `1e-3`, and
 * blanking six figures on the way through would be its own kind of broken.
 * `resolveUnit` falls back to 1 for the same reason.
 */
function isBadScale(quantity: Quantity): boolean {
  const scale = scaleOf(quantity);
  return Boolean(scale) && parseScale(scale) === null;
}

function setScale(quantity: Quantity, scale: string) {
  units.set(quantity, { scale, label: labelOf(quantity) });
}

function setLabel(quantity: Quantity, label: string) {
  units.set(quantity, { scale: scaleOf(quantity), label });
}
</script>

<template>
  <section v-if="quantities.length" data-testid="units-panel">
    <header class="mb-1 flex h-5 items-center gap-1">
      <span :class="SECTION_HEADING">units</span>
      <div class="flex-1" />
      <button
        v-if="units.isCustomised"
        type="button"
        class="rounded-xs px-1 text-2xs text-text-faint hover:bg-hover hover:text-foreground"
        data-testid="units-reset"
        @click="units.clear()"
      >
        Reset
      </button>
    </header>

    <div class="flex flex-col gap-1.5">
      <div
        v-for="quantity in quantities"
        :key="quantity"
        :data-testid="`units-${quantity}`"
        class="flex flex-col gap-0.5"
      >
        <span class="text-2xs text-text-muted">{{ quantity }}</span>
        <!-- Scale beside label, because they are one thought: "divide by a
             thousand and call it GWh". -->
        <div class="flex gap-1">
          <input
            :class="[FIELD, isBadScale(quantity) && 'border-danger']"
            :value="scaleOf(quantity)"
            type="text"
            inputmode="text"
            placeholder="1"
            :aria-invalid="isBadScale(quantity)"
            :title="`Multiply every ${quantity} value by this. “/1000” and “1e-3” both work.`"
            :data-testid="`units-${quantity}-scale`"
            @input="setScale(quantity, ($event.target as HTMLInputElement).value)"
          />
          <input
            :class="FIELD"
            :value="labelOf(quantity)"
            type="text"
            :placeholder="quantity"
            :title="`What to label ${quantity} on axes and column headers.`"
            :data-testid="`units-${quantity}-label`"
            @input="setLabel(quantity, ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
    </div>
  </section>
</template>
