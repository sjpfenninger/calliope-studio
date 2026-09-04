/**
 * Reading a JSON Schema property as a form control, and marshalling its value.
 *
 * Extracted out of `SchemaObjectEditor.vue` for the reason `lib/entries.ts`
 * exists: this is where a bug silently rewrites someone's model file, so it is
 * pure and it is tested. The component keeps the rendering; every decision about
 * what a value *is* lives here.
 *
 * Calliope's schemas make the widget question harder than it looks. `anyOf` is
 * used heavily — "a string, or a list of strings, or nothing" is three variants,
 * not a `type` — and a mapping is spelled three different ways depending on
 * whether its keys are constrained (`patternProperties`), open
 * (`additionalProperties: true`) or enumerated (`properties`). Two of those
 * three used to fall through to a widget that could not represent them:
 * `solver_options` rendered an empty box, and a `{nodes: [a, b]}` mapping
 * displayed `a,b` and wrote the *string* `"a,b"` back.
 */

import { parseScalar } from "./entries";

export type WidgetType =
  | "text"
  | "select"
  | "switch"
  | "number"
  | "commaSeparated" // string | string[] | null  ↔  one comma-joined field
  | "keyValue" // {key: value} mapping  ↔  a list of key/value rows
  | "keyValueRange" // the same, with a start→end pair as the value cell
  | "object"; // nested SchemaObjectEditor (recursive)

type Schema = Record<string, any>;

/** The branches a schema accepts, whether or not it is an `anyOf`. */
function alternatives(schema: Schema): Schema[] {
  const branches = schema?.anyOf ?? schema?.oneOf;
  return Array.isArray(branches) ? branches : [schema ?? {}];
}

/**
 * The same, without the `null` branch.
 *
 * Every optional Calliope config property is `X | null`, and the null says only
 * that the key may be absent — it never picks the control.
 */
function variants(schema: Schema): Schema[] {
  return alternatives(schema).filter((branch) => branch?.type !== "null");
}

/** Whether a schema constrains nothing at all — `additionalProperties: true`. */
function isOpen(schema: Schema): boolean {
  const branches = variants(schema);
  return branches.length === 0 || branches.every((b) => !b.type && !b.enum && !b.anyOf);
}

// ---------------------------------------------------------------------------
// Widget detection
// ---------------------------------------------------------------------------

/**
 * Which control a property gets.
 *
 * The object rule is the one that matters and the one that was wrong: an object
 * is a *nested form* only when it enumerates its own `properties`. Anything else
 * — `patternProperties`, `additionalProperties` — is a mapping the user types
 * keys into, and routing it to the recursive editor produced a bordered box with
 * a heading and no fields in it, which can never emit a value.
 */
export function detectWidget(fieldSchema: Schema): WidgetType {
  const schema = fieldSchema ?? {};
  if (schema.enum) return "select";

  const type = schema.type;
  if (type === "boolean") return "switch";
  if (type === "number" || type === "integer") return "number";
  if (type === "string") return "text";
  if (type === "array") return "commaSeparated";
  if (type === "object" || schema.patternProperties || schema.additionalProperties) {
    return schema.properties ? "object" : "keyValue";
  }

  const branches = variants(schema);
  if (branches.some((b) => b.patternProperties || (b.type === "object" && !b.properties)))
    return "keyValue";
  if (branches.some((b) => b.type === "object" && b.properties)) return "object";
  if (branches.some((b) => b.type === "array")) return "commaSeparated";
  if (branches.some((b) => b.type === "boolean")) return "switch";
  // One real branch: it is the property, wearing a `| null`.
  if (branches.length === 1 && branches[0] !== schema) return detectWidget(branches[0]);
  return "text";
}

/**
 * The schema of a mapping's values, reached through any `anyOf` wrapper.
 *
 * Data tables wrap their `patternProperties` in one (`add_dims` is
 * `{patternProperties: …} | null`) while config does not, so the lookup has to
 * descend rather than read the top level. An open mapping yields `{}`, which
 * `parseValue` reads as "infer the type from what was typed".
 */
export function valueSchemaOf(fieldSchema: Schema): Schema {
  for (const branch of variants(fieldSchema ?? {})) {
    const pattern = branch.patternProperties;
    if (pattern) {
      const first = Object.values(pattern)[0];
      if (first && typeof first === "object") return first as Schema;
    }
    const extra = branch.additionalProperties;
    if (extra && typeof extra === "object") return extra as Schema;
  }
  return {};
}

/**
 * Whether a one-item list may collapse to a bare scalar.
 *
 * True for `rows: timesteps`, which Calliope accepts either way and whose files
 * are written with the scalar. False for `shadow_prices`, which the schema
 * declares `type: array` with no scalar variant — collapsing there writes a
 * value the model will not load.
 */
export function scalarAllowed(fieldSchema: Schema): boolean {
  if (isOpen(fieldSchema)) return true; // an open schema takes anything
  return variants(fieldSchema ?? {}).some((b) => b.type && b.type !== "array");
}

/** Whether duplicate list items should be dropped, per the schema's own claim. */
function isUnique(fieldSchema: Schema): boolean {
  if (fieldSchema?.uniqueItems) return true;
  return variants(fieldSchema ?? {}).some((b) => b.uniqueItems);
}

// ---------------------------------------------------------------------------
// Value ↔ text
// ---------------------------------------------------------------------------

/**
 * A value as the text of an input.
 *
 * Driven by the value rather than by its schema: what a loaded value *is* is the
 * only reliable statement about how it should read, and a schema offering three
 * variants cannot say which one this one took.
 */
export function formatValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * A value as prose, for a row that shows it rather than editing it.
 *
 * Separate from `formatValue` because the two answer different questions.
 * `formatValue` produces the text of an input, so it must round-trip through
 * `parseValue`; this one only has to read well, and a mapping shown as
 * `{"dispatch":"custom-math.yaml"}` does not.
 */
export function describeValue(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${formatValue(item)}`)
      .join(", ");
  }
  return formatValue(value);
}

/** A comma-separated field as a list: trimmed, empties dropped, optionally unique. */
export function parseList(text: string, options: { unique?: boolean } = {}): string[] {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return options.unique ? [...new Set(parts)] : parts;
}

/**
 * A scalar typed into a field the schema does not constrain.
 *
 * The round-trip guard is what keeps it honest: `"04"` stays a string because
 * `String(Number("04"))` is `"4"`, so converting it would not be a reading of
 * what the user typed but a rewriting of it. Solver options are full of both —
 * `threads: 4` and `mip_start: "04"` are different things.
 */
function inferScalar(text: string): unknown {
  if (text === "true") return true;
  if (text === "false") return false;
  const asNumber = Number(text);
  if (!Number.isNaN(asNumber) && String(asNumber) === text) return asNumber;
  return text;
}

/**
 * The text of an input as the value the model file should carry.
 *
 * An empty field is `null`, which the callers read as "remove the key" rather
 * than "write an explicit null" — writing `[]` or `null` into a file that had no
 * such key is a change to a file the user did not edit.
 */
export function parseValue(fieldSchema: Schema, text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const branches = variants(fieldSchema ?? {});
  if (branches.some((b) => b.type === "array")) {
    const list = parseList(trimmed, { unique: isUnique(fieldSchema) });
    if (!list.length) return null;
    return list.length === 1 && scalarAllowed(fieldSchema) ? list[0] : list;
  }
  if (isOpen(fieldSchema)) return inferScalar(trimmed);
  if (branches.some((b) => b.type === "number" || b.type === "integer")) {
    // `entries.parseScalar` rather than `Number()`: only a YAML number is read
    // as one, so `Infinity` stays text for the schema to flag instead of
    // crossing JSON as `null`, and `.inf` stays the spelling the server turns
    // back into infinity.
    return parseScalar(trimmed);
  }
  if (branches.some((b) => b.type === "boolean")) return trimmed === "true";
  return trimmed;
}

// ---------------------------------------------------------------------------
// Mapping rows
// ---------------------------------------------------------------------------

/** One row of a `keyValue` mapping, as edited. */
export interface KVRow {
  key: string;
  /** The text currently in the value input. */
  text: string;
  /** What the row arrived as, or absent for a row the user added. */
  loaded?: { text: string; value: unknown };
}

/**
 * Rows back to a mapping, preserving every value the user did not touch.
 *
 * The untouched rule is the whole point. `parseValue` has to guess a type for an
 * open mapping, and a guess applied to a value nobody edited turns a no-op save
 * into an edit — `solver_options: {threads: "4"}`, a deliberate string, coming
 * back as the number `4` because a *different* row was changed. So a row whose
 * text still matches what it was loaded as emits its loaded value verbatim, and
 * only an edited row is parsed at all.
 */
export function flushRows(
  rows: KVRow[],
  valueSchema: Schema,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    out[key] =
      row.loaded && row.loaded.text === row.text
        ? row.loaded.value
        : parseValue(valueSchema, row.text);
  }
  return Object.keys(out).length ? out : null;
}

/** A mapping as rows, each remembering what it arrived as. */
export function rowsFromValue(value: unknown): KVRow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const text = formatValue(item);
    return { key, text, loaded: { text, value: item } };
  });
}

/**
 * The two halves of a `keyValueRange` cell.
 *
 * A display variant over the same `text` a plain row carries, so the range
 * widget adds a control and no marshalling: `subset.timesteps` is still a list,
 * still flushed by `flushRows`, and `subset.nodes` — which is a list and not a
 * range — degrades to the same two boxes rather than to a second code path.
 */
export function rangeParts(text: string): [string, string] {
  const parts = parseList(text);
  return [parts[0] ?? "", parts[1] ?? ""];
}

/** The inverse, dropping an empty half rather than writing a blank item. */
export function rangeText(start: string, end: string): string {
  return [start.trim(), end.trim()].filter(Boolean).join(", ");
}

// ---------------------------------------------------------------------------
// Keys the schema does not describe
// ---------------------------------------------------------------------------

/**
 * Keys present in the value that the schema says nothing about.
 *
 * Guarded on the schema having actually arrived. `stores/schema.ts` swallows a
 * failed fetch and leaves `resolved` null, which reaches the editors as `{}` —
 * without this guard a transient network failure would report *every* key in the
 * model as unrecognised, which is a wall of warnings about nothing.
 */
export function unknownKeys(
  schema: Schema,
  value: Record<string, unknown> | null | undefined,
): string[] {
  const properties = schema?.properties;
  if (!properties || !Object.keys(properties).length) return [];
  return Object.keys(value ?? {}).filter((key) => !(key in properties));
}
