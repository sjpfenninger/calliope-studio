<script setup lang="ts">
/**
 * A form built from a JSON Schema, for the parts of a model that have one.
 *
 * The widget for each property is inferred from its schema and can be overridden
 * per key by the parent. That inference lives in `lib/schemaWidgets.ts`, with
 * every decision about what a value *is* — this file is rendering only.
 *
 * **A property the object actually sets is always shown.** That is the rule the
 * `tier` overlay exists to be beaten by. `hidden: true` used to do double duty,
 * meaning both "never render this" and "this one is less common", and the second
 * reading is what left a model carrying `datetime_format`, `shadow_prices` and
 * `calliope_version` looking, in the form, as though it set none of them. So:
 * `tier: "advanced"` puts a field behind a disclosure *when it is unset*, and
 * `revealed` — the keys the object arrived with — overrides it.
 *
 * `revealed` is seeded once, in setup, and never recomputed. Deliberately: were
 * it derived from the current value, clearing a field would delete its key and
 * the field would vanish from under the pointer into a collapsed group.
 *
 * Recursive: an object-typed property renders another one of these.
 */
import { computed, reactive, useId } from "vue";
import { Plus, X } from "@lucide/vue";

import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import Eyebrow from "@/components/app/Eyebrow.vue";
import FieldRow from "@/components/app/FieldRow.vue";
import InfoTip from "@/components/app/InfoTip.vue";
import PanelDisclosure from "@/components/app/PanelDisclosure.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import { parseScalar, rowKey } from "@/lib/entries";
import {
  FIELD,
  FIELD_WIDTH,
  SECTION,
  WARNING_BADGE,
  type FieldWidth,
} from "@/lib/formClasses";
import { useFocusNew } from "./focusNew";
import {
  describeValue,
  detectWidget,
  flushRows,
  formatValue,
  parseValue,
  rangeParts,
  rangeText,
  rowsFromValue,
  unknownKeys,
  valueSchemaOf,
  type KVRow,
  type WidgetType,
} from "@/lib/schemaWidgets";
import { cn } from "@/lib/utils";
// Self-import for recursive nested-object rendering.
import SchemaObjectEditor from "./SchemaObjectEditor.vue";

// ---------------------------------------------------------------------------
// Public types — re-exported so parents can import them from this file.
// ---------------------------------------------------------------------------

export interface FieldConfig {
  /** Skip this field entirely — it is not part of this form at any tier. */
  hidden?: boolean;
  /**
   * Where the field sits when the object does not set it.
   *
   * `advanced` fields are collapsed behind one disclosure per form. A field the
   * object *does* set ignores this and renders with the common ones.
   */
  tier?: "common" | "advanced";
  /**
   * Another surface writes this key, so this form shows it without editing it.
   *
   * Two writers for one key is how a panel's settings get silently reverted by
   * whichever editor was mounted with a staler copy of the section. But hiding
   * the key instead is worse: `math_paths` and `extra_math` were invisible here
   * and the form said nothing at all about a model that set them.
   */
  ownedBy?: { label: string; hint: string };
  /**
   * Why a key the schema does not describe is nonetheless expected.
   *
   * Present ⇒ the unrecognised row explains itself and offers no Remove, which
   * is what `time_subset` needs: it is the pre-0.7 spelling, the editor migrates
   * it on save, and deleting it would throw the value away instead.
   */
  expected?: string;
  /**
   * Show this field only when a condition is true.
   * field: sibling key name, or '$ctx.<name>' to read from the `context` prop.
   */
  showIf?: { field: string; eq?: any; in?: any[] };
  /** Override the auto-detected widget. */
  widget?: WidgetType;
  /** Enum option list — replaces the schema's own enum values. */
  options?: string[];
  /**
   * Values worth offering for a field the schema leaves open.
   *
   * A `datalist`, not an `enum`: the schema says any string is valid and means
   * it, so the menu narrows the typing rather than the answers. Use this rather
   * than `options` wherever the list is a convenience — `options` on a field
   * with no schema enum invents a constraint Calliope does not have.
   */
  suggestions?: string[];
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

interface FieldEntry {
  key: string;
  label: string;
  widget: WidgetType;
  fieldSchema: Record<string, any>;
  /** For a mapping widget: the schema its values must satisfy. */
  valueSchema: Record<string, any>;
  options: string[] | null;
  suggestions: string[] | null;
  /** Calliope's own prose for this property, shown on the label. */
  description: string | null;
  /** What Calliope uses when the model says nothing, shown as ghost text. */
  placeholder: string | undefined;
  inputProps: Record<string, any>;
  width: FieldWidth;
  ownedBy: { label: string; hint: string } | null;
  /** Whether it belongs behind the disclosure rather than with the common set. */
  advanced: boolean;
}

/**
 * Reka refuses an item whose value is `""`, since that is what it uses to mean
 * "nothing chosen" — and the blank row here *is* a choice: unset is not
 * nothing, it is whatever Calliope falls back to.
 */
const NONE = "__none__";

/** What is said about a key Calliope's schema does not describe. */
const UNKNOWN_HINT =
  "Calliope does not recognise this key. The model will not load until it is removed or corrected.";

/**
 * The schema's `default`, as ghost text.
 *
 * Only where it is a value the field could hold: `null` is the absence of a
 * default rather than one, and an object default (`subset`, `operate`) would
 * print `[object Object]` into a box the user is about to type in. A `switch`
 * gets none either — it has no empty state to annotate.
 */
function placeholderFor(fieldSchema: Record<string, any>): string | undefined {
  const value = fieldSchema.default;
  if (value == null || typeof value === "object") return undefined;
  return String(value);
}

/** What each widget usually holds, and therefore how much room it needs. */
const WIDGET_WIDTH: Record<WidgetType, FieldWidth> = {
  switch: "auto",
  number: "num",
  select: "short",
  text: "short",
  commaSeparated: "fill",
  keyValue: "fill",
  keyValueRange: "fill",
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
  /**
   * Whether the advanced group is open.
   *
   * A parent whose overlay uses `tier: "advanced"` must bind this and its
   * update event; the state is the user's and so belongs in a store, not here.
   */
  showAdvanced?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: Record<string, any>];
  "update:showAdvanced": [value: boolean];
}>();

/** The keys the object arrived with. See the note at the top on why it is fixed. */
const revealed = new Set(Object.keys(props.modelValue ?? {}));

// ---------------------------------------------------------------------------
// Computed field list
// ---------------------------------------------------------------------------

const allEntries = computed<FieldEntry[]>(() => {
  const properties: Record<string, any> = props.schema?.properties ?? {};
  const entries: FieldEntry[] = [];

  for (const [key, rawSchema] of Object.entries(properties)) {
    const fc = props.overlay?.[key] ?? {};
    const fieldSchema = rawSchema as Record<string, any>;

    if (fc.hidden) continue;

    // A set key beats both gates: a model that declares `operate` under
    // `mode: base` is exactly the case where seeing it matters.
    const promoted = revealed.has(key);

    if (fc.showIf && !promoted) {
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
      valueSchema: valueSchemaOf(fieldSchema),
      options,
      suggestions: fc.suggestions?.length ? fc.suggestions : null,
      description: fieldSchema.description ?? null,
      placeholder: widget === "switch" ? undefined : placeholderFor(fieldSchema),
      inputProps: fc.inputProps ?? {},
      width: fc.width ?? WIDGET_WIDTH[widget],
      ownedBy: fc.ownedBy ?? null,
      advanced: fc.tier === "advanced" && !promoted,
    });
  }
  return entries;
});

const advancedEntries = computed(() => allEntries.value.filter((e) => e.advanced));

/**
 * The form as an ordered list of groups.
 *
 * One list rather than two `v-for`s over the same widget markup: every control
 * in this file exists once, and a second copy is how the two would drift.
 */
const groups = computed(() => {
  const out = [{ id: "common", entries: allEntries.value.filter((e) => !e.advanced) }];
  if (advancedEntries.value.length) {
    out.push({ id: "advanced", entries: props.showAdvanced ? advancedEntries.value : [] });
  }
  return out;
});

/** Keys in the value that the schema says nothing about. */
const unknownEntries = computed(() =>
  unknownKeys(props.schema, props.modelValue).map((key) => ({
    key,
    text: describeValue(props.modelValue[key]),
    expected: props.overlay?.[key]?.expected ?? null,
  })),
);

/**
 * One id per instance of this editor, so a `datalist` in the `solve` section
 * cannot be reached by a same-named field in `build`. Recursive nested editors
 * get their own.
 */
const instanceId = useId();
const listId = (key: string) => `${instanceId}-${key}`;

// ---------------------------------------------------------------------------
// Drafts for the two widgets that edit text over a structured value.
//
// Read through the model and only overridden once the user types, rather than
// initialised on mount: the schema and the value arrive from two independent
// requests, and a mount-time snapshot taken before the schema landed showed an
// empty field over a populated value — which the first edit then wrote back.
// A draft outlives its flush so the input never has text pulled out from under
// the caret; the parent remounts this component when the underlying file
// changes, which is what discards them.
// ---------------------------------------------------------------------------

const textDrafts = reactive<Record<string, string>>({});
const rowDrafts = reactive<Record<string, KVRow[]>>({});

function textFor(key: string): string {
  return textDrafts[key] ?? formatValue(props.modelValue[key]);
}

/**
 * The undrafted rows, derived once per value rather than once per render.
 *
 * The rows are keyed by identity (`rowKey`), so a fresh set of objects on every
 * render would remount every row on every unrelated re-render; this keeps them
 * the same objects until the value they are read from actually changes.
 */
const modelRows = computed(() => {
  const out: Record<string, KVRow[]> = {};
  for (const entry of allEntries.value) {
    if (entry.widget === "keyValue" || entry.widget === "keyValueRange") {
      out[entry.key] = rowsFromValue(props.modelValue[entry.key]);
    }
  }
  return out;
});

function rowsFor(key: string): KVRow[] {
  return rowDrafts[key] ?? modelRows.value[key] ?? [];
}

/** The key of a row just added takes the cursor; see `focusNew`. */
const focus = useFocusNew();

function editableRows(key: string): KVRow[] {
  if (!rowDrafts[key]) rowDrafts[key] = rowsFromValue(props.modelValue[key]);
  return rowDrafts[key]!;
}

// ---------------------------------------------------------------------------
// Update helpers
// ---------------------------------------------------------------------------

/**
 * Writes one key, or removes it.
 *
 * An emptied field deletes its key rather than writing an explicit `null`. With
 * twenty more fields now on screen, the alternative is a form that sprinkles
 * `datetime_format:` and `save_logs:` into a file the user only looked at — and
 * `revealed` being fixed is what makes it safe, since the field stays where it
 * is instead of disappearing the moment it is cleared.
 */
function update(key: string, value: unknown) {
  const next: Record<string, any> = { ...props.modelValue };
  if (value === null || value === undefined) delete next[key];
  else next[key] = value;
  emit("update:modelValue", next);
}

/**
 * A number field writes a number, or removes the key — never the DOM's string.
 *
 * Unless the text is not a number at all: `Number("1,5")` is `NaN`, which JSON
 * carries as `null`, so a comma decimal used to write `zero_threshold: null`
 * into the model. The text is kept instead, for the schema validation to flag.
 */
function updateNumber(key: string, raw: string) {
  update(key, parseScalar(raw));
}

function setText(key: string, value: string) {
  textDrafts[key] = value;
}

function flushText(entry: FieldEntry) {
  update(entry.key, parseValue(entry.fieldSchema, textFor(entry.key)));
}

function setRowKey(key: string, index: number, value: string) {
  editableRows(key)[index]!.key = value;
}

function setRowText(key: string, index: number, value: string) {
  editableRows(key)[index]!.text = value;
}

/** The range cell is a view over the row's own text, so it needs no second path. */
function setRowRange(key: string, index: number, half: "start" | "end", value: string) {
  const row = editableRows(key)[index]!;
  const [start, end] = rangeParts(row.text);
  row.text = half === "start" ? rangeText(value, end) : rangeText(start, value);
}

function addRow(key: string) {
  const rows = editableRows(key);
  rows.push({ key: "", text: "" });
  focus.request(rowKey(rows[rows.length - 1]!));
}

function removeRow(entry: FieldEntry, index: number) {
  editableRows(entry.key).splice(index, 1);
  flushRowsFor(entry);
}

function flushRowsFor(entry: FieldEntry) {
  update(entry.key, flushRows(editableRows(entry.key), entry.valueSchema));
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <template v-for="group in groups" :key="group.id">
      <PanelDisclosure
        v-if="group.id === 'advanced'"
        :open="Boolean(showAdvanced)"
        :label="`advanced (${advancedEntries.length})`"
        @toggle="emit('update:showAdvanced', !showAdvanced)"
      />

      <template v-for="entry in group.entries" :key="entry.key">
        <!-- Owned elsewhere: shown, named, and not editable from here. -->
        <FieldRow
          v-if="entry.ownedBy"
          :label="entry.label"
          :description="entry.description ?? undefined"
          width="fill"
        >
          <div class="flex min-w-0 items-center gap-2">
            <span class="min-w-0 truncate text-sm text-text-dim">
              {{ describeValue(modelValue[entry.key]) || "—" }}
            </span>
            <InfoTip :label="entry.ownedBy.hint" side="right">
              <Badge variant="outline">{{ entry.ownedBy.label }}</Badge>
            </InfoTip>
          </div>
        </FieldRow>

        <FieldRow
          v-else-if="entry.widget === 'switch'"
          :label="entry.label"
          :description="entry.description ?? undefined"
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
          :description="entry.description ?? undefined"
          :width="entry.width"
        >
          <Select
            :model-value="modelValue[entry.key] == null ? NONE : String(modelValue[entry.key])"
            @update:model-value="update(entry.key, $event === NONE ? null : $event)"
          >
            <SelectTrigger
              size="sm"
              class="w-full"
              :aria-label="entry.label"
              v-bind="entry.inputProps"
            >
              <SelectValue>
                {{
                  modelValue[entry.key] == null
                    ? entry.placeholder ? `— ${entry.placeholder}` : "—"
                    : String(modelValue[entry.key])
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <!-- Blank first, so a value that was set can be unset again. A
                   select takes no placeholder, so this is where its default goes:
                   unset is not "nothing", it is whatever Calliope falls back to. -->
              <SelectItem :value="NONE">
                {{ entry.placeholder ? `— ${entry.placeholder}` : "—" }}
              </SelectItem>
              <SelectItem v-for="option in entry.options ?? []" :key="option" :value="option">
                {{ option }}
              </SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>

        <FieldRow
          v-else-if="entry.widget === 'number'"
          :label="entry.label"
          :description="entry.description ?? undefined"
          :width="entry.width"
        >
          <input
            type="number"
            :value="modelValue[entry.key] ?? ''"
            :placeholder="entry.placeholder"
            :class="FIELD"
            v-bind="entry.inputProps"
            @change="updateNumber(entry.key, ($event.target as HTMLInputElement).value)"
          />
        </FieldRow>

        <FieldRow
          v-else-if="entry.widget === 'commaSeparated'"
          :label="entry.label"
          :description="entry.description ?? undefined"
          :width="entry.width"
        >
          <input
            type="text"
            :value="textFor(entry.key)"
            :placeholder="entry.placeholder"
            :class="FIELD"
            v-bind="entry.inputProps"
            @input="setText(entry.key, ($event.target as HTMLInputElement).value)"
            @change="flushText(entry)"
          />
        </FieldRow>

        <!-- A mapping is a group of rows, not one control, so it gets a heading
             and its own rows in the same gutter rather than a label beside it. -->
        <!-- The only testid in this component, and it earns its place: a
             mapping's rows are otherwise reachable only by placeholder, which
             is not unique — several sections have them — so a check aiming at
             one group silently edited another's last row. -->
        <div
          v-else-if="entry.widget === 'keyValue' || entry.widget === 'keyValueRange'"
          class="flex flex-col gap-1"
          data-testid="schema-rows"
          :data-key="entry.key"
        >
          <div class="flex items-center justify-between">
            <InfoTip :label="entry.description ?? ''" side="right">
              <Eyebrow>{{ entry.label }}</Eyebrow>
            </InfoTip>
            <TooltipButton
              label="Add a row"
              :icon="Plus"
              size="xs"
              @click="addRow(entry.key)"
            />
          </div>
          <!-- Keyed by the row's own identity, never by its index: the
               inputs are seeded from the row, and a reused instance kept the
               removed row's text under the next row's key. -->
          <FieldRow
            v-for="(row, j) in rowsFor(entry.key)"
            :key="rowKey(row)"
            :label="row.key"
          >
            <template #label>
              <input
                :value="row.key"
                type="text"
                placeholder="key"
                :ref="(el) => focus.bind(el, rowKey(row))"
                :class="FIELD"
                @input="setRowKey(entry.key, j, ($event.target as HTMLInputElement).value)"
                @change="flushRowsFor(entry)"
              />
            </template>
            <!-- A range is a display variant over the same text: still one list,
                 still flushed by the same path, so `subset: {nodes: [a, b, c]}`
                 degrades to the two boxes rather than to a second code path. -->
            <div
              v-if="entry.widget === 'keyValueRange'"
              class="flex items-center gap-2"
            >
              <input
                :value="rangeParts(row.text)[0]"
                type="text"
                placeholder="start"
                :class="cn(FIELD, FIELD_WIDTH.short)"
                @change="
                  setRowRange(
                    entry.key,
                    j,
                    'start',
                    ($event.target as HTMLInputElement).value,
                  );
                  flushRowsFor(entry);
                "
              />
              <span class="text-text-faint">→</span>
              <input
                :value="rangeParts(row.text)[1]"
                type="text"
                placeholder="end"
                :class="cn(FIELD, FIELD_WIDTH.short)"
                @change="
                  setRowRange(
                    entry.key,
                    j,
                    'end',
                    ($event.target as HTMLInputElement).value,
                  );
                  flushRowsFor(entry);
                "
              />
            </div>
            <input
              v-else
              :value="row.text"
              type="text"
              placeholder="value"
              :class="FIELD"
              @input="setRowText(entry.key, j, ($event.target as HTMLInputElement).value)"
              @change="flushRowsFor(entry)"
            />
            <template #action>
              <TooltipButton
                label="Remove this row"
                :icon="X"
                tone="danger"
                size="xs"
                @click="removeRow(entry, j)"
              />
            </template>
          </FieldRow>
        </div>

        <!-- Likewise a nested object: heading above, so its own fields keep the
             gutter rather than indenting it inside another one. -->
        <div v-else-if="entry.widget === 'object'" :class="SECTION">
          <InfoTip :label="entry.description ?? ''" side="right">
            <Eyebrow>{{ entry.label }}</Eyebrow>
          </InfoTip>
          <SchemaObjectEditor
            :schema="entry.fieldSchema"
            :model-value="modelValue[entry.key] ?? {}"
            :overlay="nestedOverlays?.[entry.key]"
            :context="context"
            :show-advanced="showAdvanced"
            @update:model-value="update(entry.key, $event)"
          />
        </div>

        <FieldRow
          v-else
          :label="entry.label"
          :description="entry.description ?? undefined"
          :width="entry.width"
        >
          <input
            type="text"
            :value="modelValue[entry.key] != null ? String(modelValue[entry.key]) : ''"
            :placeholder="entry.placeholder"
            :list="entry.suggestions ? listId(entry.key) : undefined"
            :class="FIELD"
            v-bind="entry.inputProps"
            @change="
              update(entry.key, ($event.target as HTMLInputElement).value || null)
            "
          />
          <!-- A menu, not a constraint: the schema says any string is valid here
               and the field goes on accepting one. -->
          <datalist v-if="entry.suggestions" :id="listId(entry.key)">
            <option v-for="value in entry.suggestions" :key="value" :value="value" />
          </datalist>
        </FieldRow>
      </template>
    </template>

    <!-- Keys the schema does not describe. Preserved on save either way; this is
         so the model does not carry one the user cannot see. -->
    <div v-if="unknownEntries.length" class="flex flex-col gap-1">
      <Eyebrow>not recognised</Eyebrow>
      <FieldRow
        v-for="entry in unknownEntries"
        :key="entry.key"
        :label="entry.key"
        width="fill"
      >
        <div class="flex min-w-0 items-center gap-2">
          <span class="min-w-0 truncate text-sm text-text-dim">{{ entry.text }}</span>
          <InfoTip :label="entry.expected ?? UNKNOWN_HINT" side="right">
            <Badge variant="outline" :class="WARNING_BADGE">
              {{ entry.expected ? "migrated" : "unknown" }}
            </Badge>
          </InfoTip>
        </div>
        <template #action>
          <TooltipButton
            v-if="!entry.expected"
            label="Remove this key"
            :icon="X"
            tone="danger"
            size="xs"
            @click="update(entry.key, null)"
          />
        </template>
      </FieldRow>
    </div>
  </div>
</template>
