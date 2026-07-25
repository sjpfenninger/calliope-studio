<script setup lang="ts">
import { reactive, computed, onMounted } from "vue";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import ToggleSwitch from "primevue/toggleswitch";
import InputNumber from "primevue/inputnumber";
import Button from "primevue/button";
// Self-import for recursive nested-object rendering.
import SchemaObjectEditor from "./SchemaObjectEditor.vue";

// ---------------------------------------------------------------------------
// Public types — re-exported so parents can import them from this file.
// ---------------------------------------------------------------------------

export interface FieldConfig {
  /** Skip this field entirely. */
  hidden?: boolean;
  /**
   * Show this field only when a condition is true.
   * field: sibling key name, or '$ctx.<name>' to read from the `context` prop.
   */
  showIf?: { field: string; eq?: any; in?: any[] };
  /** Override the auto-detected widget. */
  widget?: WidgetType;
  /** Enum option list — replaces the schema's own enum values. */
  options?: string[];
  /** Extra props forwarded verbatim to the PrimeVue component. */
  inputProps?: Record<string, any>;
  /** Display label (defaults to the property key). */
  label?: string;
}

export type FieldOverlay = Record<string, FieldConfig>;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type WidgetType =
  | "InputText"
  | "Select"
  | "ToggleSwitch"
  | "InputNumber"
  | "CommaSeparated" // string | string[] | null  ↔  comma-joined InputText
  | "KVPairs" // {key: val} dict  ↔  dynamic key+value row list
  | "SchemaObject"; // nested SchemaObjectEditor (recursive)

interface KVPair {
  key: string;
  value: string;
}

interface FieldEntry {
  key: string;
  label: string;
  widget: WidgetType;
  fieldSchema: Record<string, any>;
  options: string[] | null;
  inputProps: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Props / emits
// ---------------------------------------------------------------------------

const props = defineProps<{
  /** Fully-resolved (no $refs) JSON Schema for this object. */
  schema: Record<string, any>;
  modelValue: Record<string, any>;
  overlay?: FieldOverlay;
  /** Extra values used by showIf conditions prefixed with '$ctx.'. */
  context?: Record<string, any>;
  /** Per-key overlays forwarded to auto-rendered nested SchemaObjectEditor instances. */
  nestedOverlays?: Record<string, FieldOverlay>;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: Record<string, any>];
}>();

// ---------------------------------------------------------------------------
// Widget auto-detection
// ---------------------------------------------------------------------------

function detectWidget(fieldSchema: Record<string, any>): WidgetType {
  if (fieldSchema.enum) return "Select";
  const type = fieldSchema.type;
  if (type === "boolean") return "ToggleSwitch";
  if (type === "number" || type === "integer") return "InputNumber";
  if (type === "string") return "InputText";
  if (type === "object" && !fieldSchema.patternProperties) return "SchemaObject";
  if (fieldSchema.patternProperties) return "KVPairs";

  // anyOf / oneOf — inspect variants
  const anyOf: any[] = fieldSchema.anyOf ?? fieldSchema.oneOf ?? [];
  if (anyOf.length) {
    const hasPatternProps = anyOf.some(
      (s) => s.patternProperties || s.type === "object"
    );
    if (hasPatternProps) return "KVPairs";
    const hasArray = anyOf.some((s) => s.type === "array");
    if (hasArray) return "CommaSeparated";
    if (anyOf.some((s) => s.type === "boolean")) return "ToggleSwitch";
  }
  return "InputText";
}

// ---------------------------------------------------------------------------
// Computed field list
// ---------------------------------------------------------------------------

const fieldEntries = computed<FieldEntry[]>(() => {
  const properties: Record<string, any> = props.schema?.properties ?? {};
  const entries: FieldEntry[] = [];

  for (const [key, rawSchema] of Object.entries(properties)) {
    const fc = props.overlay?.[key] ?? {};
    const fieldSchema = rawSchema as Record<string, any>;

    if (fc.hidden) continue;

    if (fc.showIf) {
      const { field, eq, in: inList } = fc.showIf;
      const isCtx = field.startsWith("$ctx.");
      const checkField = isCtx ? field.slice(5) : field;
      const checkIn = isCtx ? props.context : props.modelValue;
      const actual = checkIn?.[checkField];
      const visible = inList ? inList.includes(actual) : actual === eq;
      if (!visible) continue;
    }

    const widget: WidgetType = (fc.widget as WidgetType | undefined) ?? detectWidget(fieldSchema);
    const options = fc.options ?? fieldSchema.enum ?? null;

    entries.push({
      key,
      label: fc.label ?? key,
      widget,
      fieldSchema,
      options,
      inputProps: fc.inputProps ?? {},
    });
  }
  return entries;
});

// ---------------------------------------------------------------------------
// Local mutable caches for CommaSeparated and KVPairs widgets.
// Initialized from modelValue on mount; writes go up via emit.
// The parent should use :key="<stable-id>" so this component remounts when
// the underlying data source changes (e.g. on file switch).
// ---------------------------------------------------------------------------

const commaSepCache = reactive<Record<string, string>>({});
const kvCache = reactive<Record<string, KVPair[]>>({});

function initCaches() {
  const properties: Record<string, any> = props.schema?.properties ?? {};
  for (const [key, rawSchema] of Object.entries(properties)) {
    const fieldSchema = rawSchema as Record<string, any>;
    const widget = (props.overlay?.[key]?.widget as WidgetType | undefined) ?? detectWidget(fieldSchema);
    if (widget === "CommaSeparated") {
      const v = props.modelValue[key];
      commaSepCache[key] = Array.isArray(v) ? v.join(", ") : (v ?? "");
    } else if (widget === "KVPairs") {
      const v = props.modelValue[key];
      kvCache[key] =
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.entries(v).map(([k, val]) => ({ key: k, value: String(val) }))
          : [];
    }
  }
}

onMounted(initCaches);

// ---------------------------------------------------------------------------
// Update helpers
// ---------------------------------------------------------------------------

function update(key: string, value: any) {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}

function updateCommaSep(key: string) {
  const s = commaSepCache[key] ?? "";
  const parts = s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const val =
    parts.length === 0 ? null : parts.length === 1 ? parts[0] : parts;
  update(key, val);
}

function addKVRow(key: string) {
  kvCache[key] = [...(kvCache[key] ?? []), { key: "", value: "" }];
}

function removeKVRow(key: string, i: number) {
  const pairs = [...(kvCache[key] ?? [])];
  pairs.splice(i, 1);
  kvCache[key] = pairs;
  flushKV(key);
}

function flushKV(key: string) {
  const obj = Object.fromEntries(
    (kvCache[key] ?? []).filter((p) => p.key).map((p) => [p.key, p.value])
  );
  update(key, Object.keys(obj).length ? obj : null);
}
</script>

<template>
  <div class="schema-fields">
    <template v-for="entry in fieldEntries" :key="entry.key">

      <!-- ToggleSwitch — inline (label left, switch right) -->
      <div v-if="entry.widget === 'ToggleSwitch'" class="field inline-field">
        <label>{{ entry.label }}</label>
        <ToggleSwitch
          :modelValue="!!modelValue[entry.key]"
          @update:modelValue="update(entry.key, $event)"
          v-bind="entry.inputProps"
        />
      </div>

      <!-- Select -->
      <div v-else-if="entry.widget === 'Select'" class="field">
        <label>{{ entry.label }}</label>
        <Select
          :modelValue="modelValue[entry.key] ?? null"
          :options="entry.options ?? []"
          @update:modelValue="update(entry.key, $event)"
          size="small"
          class="w-full"
          showClear
          v-bind="entry.inputProps"
        />
      </div>

      <!-- InputNumber -->
      <div v-else-if="entry.widget === 'InputNumber'" class="field">
        <label>{{ entry.label }}</label>
        <InputNumber
          :modelValue="modelValue[entry.key] ?? null"
          @update:modelValue="update(entry.key, $event)"
          size="small"
          class="w-full"
          v-bind="entry.inputProps"
        />
      </div>

      <!-- CommaSeparated: string | string[] | null ↔ comma-joined text -->
      <div v-else-if="entry.widget === 'CommaSeparated'" class="field">
        <label>{{ entry.label }}</label>
        <InputText
          v-model="commaSepCache[entry.key]"
          @change="updateCommaSep(entry.key)"
          size="small"
          class="w-full"
          v-bind="entry.inputProps"
        />
      </div>

      <!-- KVPairs: {key: val} dict ↔ dynamic key+value row list -->
      <div v-else-if="entry.widget === 'KVPairs'" class="field">
        <div class="kv-header">
          <label>{{ entry.label }}</label>
          <Button icon="pi pi-plus" size="small" text @click="addKVRow(entry.key)" />
        </div>
        <div
          v-for="(pair, j) in kvCache[entry.key] ?? []"
          :key="j"
          class="kv-row"
        >
          <InputText
            v-model="pair.key"
            placeholder="key"
            size="small"
            @change="flushKV(entry.key)"
          />
          <InputText
            v-model="pair.value"
            placeholder="value"
            size="small"
            @change="flushKV(entry.key)"
          />
          <Button
            icon="pi pi-times"
            size="small"
            text
            severity="danger"
            @click="removeKVRow(entry.key, j)"
          />
        </div>
      </div>

      <!-- Nested SchemaObjectEditor (recursive) -->
      <div v-else-if="entry.widget === 'SchemaObject'" class="field nested-object">
        <label class="nested-label">{{ entry.label }}</label>
        <SchemaObjectEditor
          :schema="entry.fieldSchema"
          :modelValue="modelValue[entry.key] ?? {}"
          :overlay="nestedOverlays?.[entry.key]"
          :context="context"
          @update:modelValue="update(entry.key, $event)"
        />
      </div>

      <!-- InputText (default) -->
      <div v-else class="field">
        <label>{{ entry.label }}</label>
        <InputText
          :modelValue="modelValue[entry.key] != null ? String(modelValue[entry.key]) : ''"
          @update:modelValue="update(entry.key, $event || null)"
          size="small"
          class="w-full"
          v-bind="entry.inputProps"
        />
      </div>

    </template>
  </div>
</template>

<style scoped>
.schema-fields {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.field label {
  font-size: 0.8rem;
  font-family: monospace;
  color: var(--p-text-color, #333);
}

.inline-field {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.kv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.kv-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.kv-row :deep(.p-inputtext) {
  flex: 1;
}

.nested-object {
  padding: 0.5rem;
  border: 1px solid var(--p-content-border-color, #e0e0e0);
  border-radius: 4px;
}

.nested-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color, #888) !important;
  margin-bottom: 0.25rem;
}

.w-full {
  width: 100%;
}
</style>
