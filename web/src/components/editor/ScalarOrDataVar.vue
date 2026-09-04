<script setup lang="ts">
/**
 * A parameter value, which in Calliope is either a scalar or an indexed table.
 *
 * Simple mode is one field. Structured mode is `data`, `index` and `dims`,
 * matching Calliope's `IndexedTechNodeParam`. The toggle switches between them:
 * going simple takes `data[0]` as the scalar, going structured puts the scalar
 * into `data`.
 *
 * Both shapes have to be editable in place, because a model mixes them freely —
 * `flow_cap_max: 100` next to a `cost_flow_cap` indexed over cost classes.
 *
 * **The shape a value arrived in is the shape it leaves in.** A list such as
 * `carrier_out: [electricity, heat]` is shown comma-separated and goes back as
 * a list; it used to be `String(array)` — `electricity,heat` — and any edit
 * wrote that string into the file, which Calliope then read as one carrier
 * called `electricity,heat`. Likewise the numbers in an indexed parameter's
 * `data:` are parsed as numbers, where a touched field used to re-emit
 * `[100, 200]` as `['100', '200']`.
 */
import { ref, watch } from "vue";
import { MinusCircle, Table2 } from "@lucide/vue";

import TooltipButton from "@/components/app/TooltipButton.vue";
import { FIELD } from "@/lib/formClasses";
import { parseScalar, parseScalarList } from "@/lib/entries";

const props = defineProps<{
  modelValue: any;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: any];
}>();

// Detect initial mode from the current value.
function isStructuredValue(v: any): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v) && "data" in v;
}

const structured = ref(isStructuredValue(props.modelValue));

/** Whether the simple field holds a list, which it then keeps writing as one. */
const isList = ref(Array.isArray(props.modelValue));

function valueToString(v: any): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

// Local reactive state — avoid mutating props.
const scalarText = ref<string>(structured.value ? "" : valueToString(props.modelValue));

const dataText = ref<string>(
  structured.value ? valueToString(props.modelValue?.data) : "",
);
const indexText = ref<string>(
  structured.value ? valueToString(props.modelValue?.index) : "",
);
const dimsText = ref<string>(
  structured.value ? valueToString(props.modelValue?.dims) : "",
);

/**
 * Adopt a value that arrived from outside.
 *
 * The four fields were snapshotted at setup and never looked at the prop again,
 * which is only safe if the instance is never reused for a different value.
 * `ParamRows` now keys its rows by identity so that it is not — but a form can
 * still be handed a fresh entry, and a reverted field still changes underneath
 * this. The guard is the round trip: what this component last *emitted* comes
 * straight back as `modelValue`, and re-deriving the text from it would
 * normalise what the user is typing mid-keystroke ("1," becoming "1").
 */
function adopt(value: any): void {
  structured.value = isStructuredValue(value);
  isList.value = Array.isArray(value);
  if (structured.value) {
    dataText.value = valueToString(value?.data);
    indexText.value = valueToString(value?.index);
    dimsText.value = valueToString(value?.dims);
    scalarText.value = "";
  } else {
    scalarText.value = valueToString(value);
    dataText.value = "";
    indexText.value = "";
    dimsText.value = "";
  }
}

let emitted: any = props.modelValue;

watch(
  () => props.modelValue,
  (value) => {
    if (value === emitted) return;
    adopt(value);
  },
);

/** Dimension names stay text: `costs` is a name whatever it looks like. */
function parseNames(s: string): string | string[] | null {
  const parts = s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return parts;
}

/** Values: a number where it reads as one, one item as a scalar, more as a list. */
function parseValues(s: string): string | number | (string | number)[] | null {
  const parts = parseScalarList(s);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return parts;
}

function emitScalar() {
  emitted = isList.value ? parseScalarList(scalarText.value) : parseScalar(scalarText.value);
  if (Array.isArray(emitted) && emitted.length === 0) emitted = null;
  emit("update:modelValue", emitted);
}

function emitStructured() {
  const data = parseValues(dataText.value);
  // Index labels are parsed like values, not like names: YAML reads a bare
  // `2030` as a number, so `index: [2020, 2030]` over a `years` dimension is
  // two ints in the file, and the field has to hand them back as ints or an
  // edit to any of the three boxes rewrites them as `['2020', '2030']`.
  const index = parseValues(indexText.value);
  const dims = parseNames(dimsText.value);
  if (data === null && index === null && dims === null) {
    emitted = null;
  } else {
    // Only the keys that have something in them: a parameter that had no
    // `dims:` must not gain `dims: null` from an edit to its `data:`.
    emitted = {
      ...(data !== null && { data }),
      ...(index !== null && { index }),
      ...(dims !== null && { dims }),
    };
  }
  emit("update:modelValue", emitted);
}

function toggleMode() {
  if (structured.value) {
    // Switch to simple: use data field as scalar
    scalarText.value = dataText.value.split(",")[0]?.trim() ?? "";
    structured.value = false;
    isList.value = false;
    emitScalar();
  } else {
    // Switch to structured: put scalar in data field
    dataText.value = scalarText.value;
    indexText.value = "";
    dimsText.value = "";
    structured.value = true;
    emitStructured();
  }
}

// The tone a field label gets (`FIELD_LABEL`), at the control size: these three
// are captions on real fields, and the faint step is the disabled one.
const SUB_LABEL = "w-10 shrink-0 text-right text-sm text-text-dim";
</script>

<template>
  <div class="flex w-full items-start gap-1">
    <template v-if="!structured">
      <input v-model="scalarText" type="text" :class="FIELD" @change="emitScalar" />
      <TooltipButton
        label="Switch to indexed form"
        :icon="Table2"
        size="xs"
        @click="toggleMode"
      />
    </template>

    <template v-else>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <label class="flex items-center gap-1.5">
          <span :class="SUB_LABEL">data</span>
          <input
            v-model="dataText"
            type="text"
            :class="FIELD"
            placeholder="value(s)"
            @change="emitStructured"
          />
        </label>
        <label class="flex items-center gap-1.5">
          <span :class="SUB_LABEL">index</span>
          <input
            v-model="indexText"
            type="text"
            :class="FIELD"
            placeholder="index value(s)"
            @change="emitStructured"
          />
        </label>
        <label class="flex items-center gap-1.5">
          <span :class="SUB_LABEL">dims</span>
          <input
            v-model="dimsText"
            type="text"
            :class="FIELD"
            placeholder="dimension name(s)"
            @change="emitStructured"
          />
        </label>
      </div>
      <TooltipButton
        label="Switch to scalar form"
        :icon="MinusCircle"
        size="xs"
        @click="toggleMode"
      />
    </template>
  </div>
</template>
