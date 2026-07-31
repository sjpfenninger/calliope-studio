<script setup lang="ts">
/**
 * The free parameters of an entry: a key, a value, and a way to remove it.
 *
 * A technology may carry any parameter at all, so every entity form ends in the
 * same list of key/value rows. It was written out four times — in the nodes,
 * links and techs forms, and again with a wider key column in the overrides
 * editor — which is how the key input came to be 144px in three of them and
 * 256px in the fourth, and why the rows never lined up with the fixed fields
 * above them. The key input now fills the same gutter as a fixed field's label,
 * so the whole form reads down one seam.
 *
 * It also renders the **ghost rows**: keys a template or data table supplies
 * that this form has no field for and this entry has no parameter for. Those
 * were the one thing the old separate inherited-values table showed that nothing
 * else would, so folding provenance onto the fields would otherwise have lost
 * them. Typing into a ghost makes it a real parameter.
 */
import { computed } from "vue";
import { Plus, X } from "@lucide/vue";

import ScalarOrDataVar from "./ScalarOrDataVar.vue";
import Eyebrow from "@/components/app/Eyebrow.vue";
import FieldRow from "@/components/app/FieldRow.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import { FIELD, GHOST_BUTTON } from "@/lib/formClasses";
import { cn } from "@/lib/utils";
import { parseScalar, type Param } from "@/lib/entries";
import { unmatchedInherited, type Inherited } from "@/lib/inherited";

const props = withDefaults(
  defineProps<{
    /** Edited in place, as every one of these forms already does. */
    params: Param[];
    /** What a template or data table supplies, by key. */
    inherited?: Record<string, Inherited>;
    /** Keys the surrounding form has a field for, so they get no ghost row. */
    promoted?: string[];
    /** "Add parameter", or "Add override" inside a node's tech. */
    addLabel?: string;
  }>(),
  { inherited: () => ({}), promoted: () => [], addLabel: "Add parameter" },
);

const emit = defineEmits<{ change: [] }>();

const ghosts = computed(() =>
  unmatchedInherited(props.inherited, props.promoted, props.params),
);

function add() {
  props.params.push({ key: "", value: null });
  emit("change");
}

function remove(index: number) {
  props.params.splice(index, 1);
  emit("change");
}

/**
 * Turn a ghost into a real parameter.
 *
 * On `change` rather than `input`: materialising swaps the ghost row for a real
 * one, and doing that on every keystroke would pull the input out from under the
 * caret. An empty value leaves the ghost alone, so tabbing through the list does
 * not litter the entry with blank keys.
 */
function materialise(key: string, raw: string) {
  const value = parseScalar(raw);
  if (value === null) return;
  props.params.push({ key, value });
  emit("change");
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <FieldRow
      v-for="(param, index) in params"
      :key="index"
      :label="param.key"
      width="value"
      align="start"
      :inherited="inherited[param.key] ?? null"
      is-set
      :revertable="false"
    >
      <template #label>
        <input
          v-model="param.key"
          type="text"
          placeholder="parameter"
          :class="FIELD"
          @input="emit('change')"
        />
      </template>

      <ScalarOrDataVar
        :model-value="param.value"
        @update:model-value="
          param.value = $event;
          emit('change');
        "
      />

      <template #action>
        <TooltipButton
          label="Remove this parameter"
          :icon="X"
          tone="danger"
          @click="remove(index)"
        />
      </template>
    </FieldRow>

    <button type="button" :class="cn(GHOST_BUTTON, 'self-start')" @click="add">
      <Plus class="size-3.5" />
      {{ addLabel }}
    </button>

    <!-- What this entry gets but does not say: editable in place, so overriding
         one is typing in it rather than finding the name and adding it back. -->
    <template v-if="ghosts.length">
      <Eyebrow class="mt-1">inherited</Eyebrow>
      <FieldRow
        v-for="key in ghosts"
        :key="key"
        :label="key"
        width="value"
        :inherited="inherited[key]"
      >
        <template #default="{ placeholder }">
          <input
            type="text"
            :class="FIELD"
            :placeholder="placeholder"
            @change="materialise(key, ($event.target as HTMLInputElement).value)"
          />
        </template>
      </FieldRow>
    </template>
  </div>
</template>
