<script setup lang="ts">
/**
 * ScalarOrDataVar — two-mode input for Calliope tech/node parameters.
 *
 * Simple mode (default): a single InputText for scalar values (strings, numbers).
 * Structured mode: three InputText fields for `data`, `index`, and `dims`
 *   matching Calliope's IndexedTechNodeParam schema.
 *
 * The ⊞ toggle button switches between modes. Switching to simple mode
 * serialises data[0] as the scalar; switching to structured expands.
 */
import { ref } from "vue";
import InputText from "primevue/inputtext";
import Button from "primevue/button";

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
  structured.value ? "" : (props.modelValue != null ? String(props.modelValue) : "")
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
  structured.value ? valueToDataString(props.modelValue?.data) : ""
);
const indexText = ref<string>(
  structured.value ? valueToString(props.modelValue?.index) : ""
);
const dimsText = ref<string>(
  structured.value ? valueToString(props.modelValue?.dims) : ""
);

function parseCommaSep(s: string): string | string[] | null {
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
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
</script>

<template>
  <div class="sdv-root">
    <!-- Simple mode -->
    <template v-if="!structured">
      <InputText
        v-model="scalarText"
        size="small"
        class="sdv-scalar"
        @change="emitScalar"
      />
      <Button
        icon="pi pi-table"
        size="small"
        text
        severity="secondary"
        class="sdv-toggle"
        title="Switch to indexed form"
        @click="toggleMode"
      />
    </template>

    <!-- Structured mode -->
    <template v-else>
      <div class="sdv-structured">
        <div class="sdv-row">
          <span class="sdv-sub-label">data</span>
          <InputText
            v-model="dataText"
            size="small"
            class="sdv-input"
            placeholder="value(s)"
            @change="emitStructured"
          />
        </div>
        <div class="sdv-row">
          <span class="sdv-sub-label">index</span>
          <InputText
            v-model="indexText"
            size="small"
            class="sdv-input"
            placeholder="index value(s)"
            @change="emitStructured"
          />
        </div>
        <div class="sdv-row">
          <span class="sdv-sub-label">dims</span>
          <InputText
            v-model="dimsText"
            size="small"
            class="sdv-input"
            placeholder="dimension name(s)"
            @change="emitStructured"
          />
        </div>
      </div>
      <Button
        icon="pi pi-minus-circle"
        size="small"
        text
        severity="secondary"
        class="sdv-toggle"
        title="Switch to scalar form"
        @click="toggleMode"
      />
    </template>
  </div>
</template>

<style scoped>
.sdv-root {
  display: flex;
  align-items: flex-start;
  gap: 0.25rem;
  width: 100%;
}

.sdv-scalar {
  flex: 1;
}

.sdv-toggle {
  flex-shrink: 0;
  padding: 0.15rem 0.3rem;
}

.sdv-structured {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.sdv-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.sdv-sub-label {
  font-size: 0.75rem;
  font-family: monospace;
  color: var(--p-text-muted-color, #888);
  width: 2.5rem;
  flex-shrink: 0;
  text-align: right;
}

.sdv-input {
  flex: 1;
}
</style>
