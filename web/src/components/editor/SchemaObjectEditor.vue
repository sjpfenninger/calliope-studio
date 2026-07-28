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
import { Plus, X } from "@lucide/vue";

import { Switch } from "@/components/ui/switch";
import Eyebrow from "@/components/app/Eyebrow.vue";
import FieldRow from "@/components/app/FieldRow.vue";
import {
  DANGER_ICON_BUTTON,
  FIELD,
  FIELD_MONO,
  ICON_BUTTON_SM,
  type FieldWidth,
} from "@/lib/formClasses";
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
  /**
   * How wide the control should be, overriding the widget's default.
   *
   * The defaults suit what a widget usually holds — a number is 64px, a select
   * or a string 144px — because a schema-driven form otherwise gives a solver
   * name the full width of the pane. The handful of genuinely long strings, a
   * model name or a log path, ask for `fill` here.
   */
  width?: FieldWidth;
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
  width: FieldWidth;
}

/** What each widget usually holds, and therefore how much room it needs. */
const WIDGET_WIDTH: Record<WidgetType, FieldWidth> = {
  switch: "auto",
  number: "num",
  select: "short",
  text: "short",
  commaSeparated: "fill",
  keyValue: "fill",
  object: "fill",
};

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
      width: fc.width ?? WIDGET_WIDTH[widget],
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

</script>

<template>
  <div class="flex flex-col gap-2">
    <template v-for="entry in fieldEntries" :key="entry.key">
      <FieldRow
        v-if="entry.widget === 'switch'"
        :label="entry.label"
        :width="entry.width"
      >
        <Switch
          :model-value="!!modelValue[entry.key]"
          v-bind="entry.inputProps"
          @update:model-value="update(entry.key, $event)"
        />
      </FieldRow>

      <FieldRow
        v-else-if="entry.widget === 'select'"
        :label="entry.label"
        :width="entry.width"
      >
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
      </FieldRow>

      <FieldRow
        v-else-if="entry.widget === 'number'"
        :label="entry.label"
        :width="entry.width"
      >
        <input
          type="number"
          :value="modelValue[entry.key] ?? ''"
          :class="FIELD"
          v-bind="entry.inputProps"
          @change="updateNumber(entry.key, ($event.target as HTMLInputElement).value)"
        />
      </FieldRow>

      <FieldRow
        v-else-if="entry.widget === 'commaSeparated'"
        :label="entry.label"
        :width="entry.width"
      >
        <input
          v-model="commaSepCache[entry.key]"
          type="text"
          :class="FIELD"
          v-bind="entry.inputProps"
          @change="updateCommaSep(entry.key)"
        />
      </FieldRow>

      <!-- A mapping is a group of rows, not one control, so it gets a heading
           and its own rows in the same gutter rather than a label beside it. -->
      <div v-else-if="entry.widget === 'keyValue'" class="flex flex-col gap-1">
        <div class="flex items-center justify-between">
          <Eyebrow class="mb-0">{{ entry.label }}</Eyebrow>
          <button
            type="button"
            title="Add a row"
            :class="ICON_BUTTON_SM"
            @click="addKVRow(entry.key)"
          >
            <Plus class="size-3.5" />
          </button>
        </div>
        <FieldRow
          v-for="(pair, j) in kvCache[entry.key] ?? []"
          :key="j"
          :label="pair.key"
        >
          <template #label>
            <input
              v-model="pair.key"
              type="text"
              placeholder="key"
              :class="FIELD_MONO"
              @change="flushKV(entry.key)"
            />
          </template>
          <input
            v-model="pair.value"
            type="text"
            placeholder="value"
            :class="FIELD"
            @change="flushKV(entry.key)"
          />
          <template #action>
            <button
              type="button"
              title="Remove this row"
              :class="DANGER_ICON_BUTTON"
              @click="removeKVRow(entry.key, j)"
            >
              <X class="size-3.5" />
            </button>
          </template>
        </FieldRow>
      </div>

      <!-- Likewise a nested object: heading above, so its own fields keep the
           gutter rather than indenting it inside another one. -->
      <div
        v-else-if="entry.widget === 'object'"
        class="flex flex-col gap-1 rounded-sm border border-border p-2"
      >
        <Eyebrow>{{ entry.label }}</Eyebrow>
        <SchemaObjectEditor
          :schema="entry.fieldSchema"
          :model-value="modelValue[entry.key] ?? {}"
          :overlay="nestedOverlays?.[entry.key]"
          :context="context"
          @update:model-value="update(entry.key, $event)"
        />
      </div>

      <FieldRow v-else :label="entry.label" :width="entry.width">
        <input
          type="text"
          :value="modelValue[entry.key] != null ? String(modelValue[entry.key]) : ''"
          :class="FIELD"
          v-bind="entry.inputProps"
          @change="
            update(entry.key, ($event.target as HTMLInputElement).value || null)
          "
        />
      </FieldRow>
    </template>
  </div>
</template>
