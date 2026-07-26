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
 */
import { ref } from "vue";
import { MinusCircle, Table2 } from "lucide-vue-next";

import { ICON_STROKE_WIDTH } from "@/lib/icons";

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

// Local reactive state — avoid mutating props.
const scalarText = ref<string>(
  structured.value ? "" : props.modelValue != null ? String(props.modelValue) : "",
);

function valueToDataString(v: any): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function valueToString(v: any): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

const dataText = ref<string>(
  structured.value ? valueToDataString(props.modelValue?.data) : "",
);
const indexText = ref<string>(
  structured.value ? valueToString(props.modelValue?.index) : "",
);
const dimsText = ref<string>(
  structured.value ? valueToString(props.modelValue?.dims) : "",
);

function parseCommaSep(s: string): string | string[] | null {
  const parts = s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return parts;
}

function parseScalar(s: string): string | number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return isNaN(n) ? trimmed : n;
}

function emitScalar() {
  emit("update:modelValue", parseScalar(scalarText.value));
}

function emitStructured() {
  const data = parseCommaSep(dataText.value);
  const index = parseCommaSep(indexText.value);
  const dims = parseCommaSep(dimsText.value);
  if (data === null && index === null && dims === null) {
    emit("update:modelValue", null);
  } else {
    emit("update:modelValue", { data, index, dims });
  }
}

function toggleMode() {
  if (structured.value) {
    // Switch to simple: use data field as scalar
    scalarText.value = dataText.value.split(",")[0]?.trim() ?? "";
    structured.value = false;
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

const FIELD =
  "h-6 w-full min-w-0 rounded-xs border border-input bg-surface px-1.5 text-sm outline-none focus-visible:border-ring";
const TOGGLE =
  "grid size-6 shrink-0 place-items-center rounded-xs text-text-faint hover:bg-hover hover:text-foreground";
const SUB_LABEL = "w-10 shrink-0 text-right font-mono text-2xs text-text-faint";
</script>

<template>
  <div class="flex w-full items-start gap-1">
    <template v-if="!structured">
      <input v-model="scalarText" type="text" :class="FIELD" @change="emitScalar" />
      <button
        type="button"
        :class="TOGGLE"
        title="Switch to indexed form"
        @click="toggleMode"
      >
        <Table2 class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
      </button>
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
      <button
        type="button"
        :class="TOGGLE"
        title="Switch to scalar form"
        @click="toggleMode"
      >
        <MinusCircle class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
      </button>
    </template>
  </div>
</template>
