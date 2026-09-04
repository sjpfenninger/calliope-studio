<script setup lang="ts">
/**
 * How many digits of this model's numbers to show.
 *
 * Beside the units, and for the same reasons: it applies to every figure, the
 * table and the exports at once, so it belongs in the sidebar rather than in one
 * figure's header — and those headers are measured, since their height is what a
 * collapsed figure *is*.
 *
 * A sibling section rather than a row inside `RunUnitsPanel`, which renders
 * nothing at all for a model with no settable quantity in it. Precision applies
 * to every model.
 *
 * Empty means full precision, which is what every surface showed before this
 * existed — so an untouched app is unchanged, and the whole thing is opt-in.
 */
import { computed } from "vue";

import { Checkbox } from "@/components/ui/checkbox";
import InfoTip from "@/components/app/InfoTip.vue";
import SidebarSection from "@/components/app/SidebarSection.vue";
import { FIELD, FIELD_LABEL, SOFT_DISABLED, TEXT_BUTTON_SM } from "@/lib/formClasses";
import { MAX_PRECISION, isBadPrecision } from "@/lib/precision";
import { useRoundingStore } from "@/stores/rounding";

const rounding = useRoundingStore();

const isBad = computed(() => isBadPrecision(rounding.digits));

/**
 * Nothing to apply to a download while there is no precision to apply.
 *
 * Left visible rather than hidden, because it is what tells the reader the
 * export is *not* being rounded — a checkbox that appears only once you have
 * typed a number reads as a thing that just happened to your files.
 */
const canExport = computed(() => rounding.precision !== null);

function toggleExports() {
  if (!canExport.value) return;
  rounding.setExports(!rounding.exports);
}
</script>

<template>
  <SidebarSection title="rounding" data-testid="rounding-panel">
    <template #actions>
      <button
        v-if="rounding.isCustomised"
        type="button"
        :class="TEXT_BUTTON_SM"
        data-testid="rounding-reset"
        @click="rounding.clear()"
      >
        Reset
      </button>
    </template>

    <div class="flex flex-col gap-1.5">
      <div class="flex flex-col gap-0.5">
        <!-- Significant figures rather than decimal places: one frame holds a
             40 GW capacity and a 0.003 cost fraction, and two decimals flattens
             the second while padding the first. -->
        <span :class="FIELD_LABEL">significant figures</span>
        <InfoTip
          :label="`How many significant figures to show, 1 to ${MAX_PRECISION}. Empty shows every digit.`"
        >
          <input
            :class="FIELD"
            :value="rounding.digits"
            type="text"
            inputmode="numeric"
            placeholder="all"
            :aria-invalid="isBad"
            data-testid="rounding-digits"
            @input="rounding.setDigits(($event.target as HTMLInputElement).value)"
          />
        </InfoTip>
      </div>

      <!-- The row is the click target, not the box: Reka renders a button, so a
           wrapping `<label>` would not forward to it. The box is inert. -->
      <InfoTip
        label="Round downloaded CSV files too. Off by default: a CSV is what you do arithmetic on."
      >
        <div
          role="checkbox"
          :tabindex="canExport ? 0 : -1"
          :aria-checked="rounding.exports"
          :aria-disabled="!canExport"
          data-testid="rounding-exports"
          class="flex h-6 items-center gap-1.5 rounded-sm px-1 text-sm"
          :class="canExport ? 'cursor-pointer hover:bg-hover' : SOFT_DISABLED"
          @click="toggleExports()"
          @keydown.space.prevent="toggleExports()"
        >
          <Checkbox
            class="pointer-events-none"
            :model-value="rounding.exports"
            :disabled="!canExport"
          />
          <span class="truncate">apply to downloads</span>
        </div>
      </InfoTip>
    </div>
  </SidebarSection>
</template>
