<script setup lang="ts">
/**
 * A form built from a JSON Schema, for the parts of a model that have one.
 *
 * The widget for each property is inferred from its schema and can be overridden
 * per key by the parent. That inference is the load-bearing part: Calliope's
 * config schema uses `anyOf` heavily, so "a string or a list of strings" and "a
 * mapping of anything" both have to be recognised from their variants rather
 * than from a single `type`.
 *
 * Recursive: an object-typed property renders another one of these.
 */
import { reactive, computed, onMounted } from "vue";
import { Plus, X } from "lucide-vue-next";

import { ICON_STROKE_WIDTH } from "@/lib/icons";
import { Switch } from "@/components/ui/switch";
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
  /** Extra attributes forwarded verbatim to the rendered control. */
  inputProps?: Record<string, any>;
  /** Display label (defaults to the property key). */
  label?: string;
}

export type FieldOverlay = Record<string, FieldConfig>;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type WidgetType =
  | "text"
  | "select"
  | "switch"
  | "number"
  | "commaSeparated" // string | string[] | null  ↔  one comma-joined field
  | "keyValue" // {key: val} mapping  ↔  a list of key/value rows
  | "object"; // nested SchemaObjectEditor (recursive)

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
  /** Per-key overlays forwarded to auto-rendered nested editors. */
  nestedOverlays?: Record<string, FieldOverlay>;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: Record<string, any>];
}>();

// ---------------------------------------------------------------------------
// Widget auto-detection
// ---------------------------------------------------------------------------

function detectWidget(fieldSchema: Record<string, any>): WidgetType {
  if (fieldSchema.enum) return "select";
  const type = fieldSchema.type;
  if (type === "boolean") return "switch";
  if (type === "number" || type === "integer") return "number";
  if (type === "string") return "text";
  if (type === "object" && !fieldSchema.patternProperties) return "object";
  if (fieldSchema.patternProperties) return "keyValue";

  // anyOf / oneOf — inspect variants
  const anyOf: any[] = fieldSchema.anyOf ?? fieldSchema.oneOf ?? [];
  if (anyOf.length) {
    const hasPatternProps = anyOf.some(
      (s) => s.patternProperties || s.type === "object",
    );
    if (hasPatternProps) return "keyValue";
    const hasArray = anyOf.some((s) => s.type === "array");
    if (hasArray) return "commaSeparated";
    if (anyOf.some((s) => s.type === "boolean")) return "switch";
  }
  return "text";
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

    const widget: WidgetType =
      (fc.widget as WidgetType | undefined) ?? detectWidget(fieldSchema);
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
// Local mutable caches for commaSeparated and keyValue widgets.
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
    const widget =
      (props.overlay?.[key]?.widget as WidgetType | undefined) ??
      detectWidget(fieldSchema);
    if (widget === "commaSeparated") {
      const v = props.modelValue[key];
      commaSepCache[key] = Array.isArray(v) ? v.join(", ") : (v ?? "");
    } else if (widget === "keyValue") {
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
  const val = parts.length === 0 ? null : parts.length === 1 ? parts[0] : parts;
  update(key, val);
}

/** A number field writes a number, or null — never the string the DOM gives. */
function updateNumber(key: string, raw: string) {
  const trimmed = raw.trim();
  update(key, trimmed === "" ? null : Number(trimmed));
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
    (kvCache[key] ?? []).filter((p) => p.key).map((p) => [p.key, p.value]),
  );
  update(key, Object.keys(obj).length ? obj : null);
}

const FIELD =
  "h-6 w-full min-w-0 rounded-xs border border-input bg-surface px-1.5 text-sm outline-none focus-visible:border-ring";
const LABEL = "font-mono text-xs text-text-dim";
</script>

<template>
  <div class="flex flex-col gap-2">
    <template v-for="entry in fieldEntries" :key="entry.key">
      <!-- A switch reads better with its label beside it than above it. -->
      <div
        v-if="entry.widget === 'switch'"
        class="flex items-center justify-between gap-2"
      >
        <label :class="LABEL">{{ entry.label }}</label>
        <Switch
          :model-value="!!modelValue[entry.key]"
          v-bind="entry.inputProps"
          @update:model-value="update(entry.key, $event)"
        />
      </div>

      <div v-else-if="entry.widget === 'select'" class="flex flex-col gap-1">
        <label :class="LABEL">{{ entry.label }}</label>
        <select
          :value="modelValue[entry.key] ?? ''"
          :class="FIELD"
          v-bind="entry.inputProps"
          @change="
            update(entry.key, ($event.target as HTMLSelectElement).value || null)
          "
        >
          <!-- Blank first, so a value that was set can be unset again. -->
          <option value="">—</option>
          <option v-for="option in entry.options ?? []" :key="option" :value="option">
            {{ option }}
          </option>
        </select>
      </div>

      <div v-else-if="entry.widget === 'number'" class="flex flex-col gap-1">
        <label :class="LABEL">{{ entry.label }}</label>
        <input
          type="number"
          :value="modelValue[entry.key] ?? ''"
          :class="FIELD"
          v-bind="entry.inputProps"
          @change="updateNumber(entry.key, ($event.target as HTMLInputElement).value)"
        />
      </div>

      <div v-else-if="entry.widget === 'commaSeparated'" class="flex flex-col gap-1">
        <label :class="LABEL">{{ entry.label }}</label>
        <input
          v-model="commaSepCache[entry.key]"
          type="text"
          :class="FIELD"
          v-bind="entry.inputProps"
          @change="updateCommaSep(entry.key)"
        />
      </div>

      <div v-else-if="entry.widget === 'keyValue'" class="flex flex-col gap-1">
        <div class="flex items-center justify-between">
          <label :class="LABEL">{{ entry.label }}</label>
          <button
            type="button"
            title="Add a row"
            class="grid size-5 place-items-center rounded-xs text-text-faint hover:bg-hover hover:text-foreground"
            @click="addKVRow(entry.key)"
          >
            <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
          </button>
        </div>
        <div
          v-for="(pair, j) in kvCache[entry.key] ?? []"
          :key="j"
          class="flex items-center gap-1"
        >
          <input
            v-model="pair.key"
            type="text"
            placeholder="key"
            :class="FIELD"
            @change="flushKV(entry.key)"
          />
          <input
            v-model="pair.value"
            type="text"
            placeholder="value"
            :class="FIELD"
            @change="flushKV(entry.key)"
          />
          <button
            type="button"
            title="Remove this row"
            class="grid size-6 shrink-0 place-items-center rounded-xs text-text-faint hover:bg-danger-soft hover:text-danger-text"
            @click="removeKVRow(entry.key, j)"
          >
            <X class="size-3.5" :stroke-width="2" />
          </button>
        </div>
      </div>

      <div
        v-else-if="entry.widget === 'object'"
        class="flex flex-col gap-1 rounded-sm border border-border p-2"
      >
        <label
          class="mb-0.5 text-2xs font-semibold uppercase tracking-wide text-text-faint"
        >
          {{ entry.label }}
        </label>
        <SchemaObjectEditor
          :schema="entry.fieldSchema"
          :model-value="modelValue[entry.key] ?? {}"
          :overlay="nestedOverlays?.[entry.key]"
          :context="context"
          @update:model-value="update(entry.key, $event)"
        />
      </div>

      <div v-else class="flex flex-col gap-1">
        <label :class="LABEL">{{ entry.label }}</label>
        <input
          type="text"
          :value="modelValue[entry.key] != null ? String(modelValue[entry.key]) : ''"
          :class="FIELD"
          v-bind="entry.inputProps"
          @change="
            update(entry.key, ($event.target as HTMLInputElement).value || null)
          "
        />
      </div>
    </template>
  </div>
</template>
