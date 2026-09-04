import type { RawTech } from "./techs";

/**
 * Turning a YAML entry into a form, and back.
 *
 * This is where a bug silently corrupts a user's model, and it was the least
 * tested code in the repository: three near-identical `rawToEntry` /
 * `entryToRaw` pairs, each inside a `<script setup>` block and therefore
 * unreachable from a test.
 *
 * The rules they all share, and which are easy to lose:
 *
 * - **`active: false` is written; `active: true` is not.** Absent means active,
 *   so writing the default would add a line to every entry in the file.
 * - **An empty value drops the key** rather than writing `""`, which Calliope
 *   would read as an empty string rather than as "unset".
 * - **Unrecognised keys survive.** A technology may carry any parameter at all,
 *   so anything the form does not have a field for is round-tripped as-is.
 */

export interface Param {
  key: string;
  value: any;
}

/** Whether a value is worth writing, or should drop its key entirely. */
function isSet(value: any): boolean {
  return value !== null && value !== undefined && value !== "";
}

/**
 * What the DOM's string means as a parameter value.
 *
 * A number where it reads as one, the trimmed text otherwise, and null for
 * empty — which is what drops the key. Here rather than inside a form, because
 * two controls now take a raw parameter value and a second copy of "is this a
 * number" is how `.inf` came to be deleted from people's files once already.
 */
export function parseScalar(raw: string): string | number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Only a YAML number is read as one. `Number()` also accepts `0x1A`, `0b11`
  // and `Infinity` — and JSON cannot carry `Infinity`, so `axios` sent it as
  // `null` and the file gained an empty value where the user typed a word.
  if (!NUMBER.test(trimmed)) return trimmed;
  const asNumber = Number(trimmed);
  return Number.isFinite(asNumber) ? asNumber : trimmed;
}

/** A decimal or scientific number, as YAML spells one. Hex and words are text. */
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;

/** A comma-separated field as a list of values, each read like `parseScalar`. */
export function parseScalarList(raw: string): (string | number)[] {
  return raw
    .split(",")
    .map((part) => parseScalar(part))
    .filter((value): value is string | number => value !== null);
}

function paramsToObject(params: Param[]): Record<string, any> {
  const result: Record<string, any> = {};
  for (const { key, value } of params) {
    if (key && isSet(value)) result[key] = value;
  }
  return result;
}

function objectToParams(raw: Record<string, any> | null | undefined): Param[] {
  return Object.entries(raw ?? {}).map(([key, value]) => ({ key, value }));
}

// ── Technologies ────────────────────────────────────────────────────────────

export interface TechEntry {
  name: string;
  template: string | null;
  base_tech: string | null;
  active: boolean;
  extraParams: Param[];
}

/** Fields the techs form promotes out of the parameter list. */
const TECH_PROMOTED = new Set(["base_tech", "active", "template"]);

export function rawToTech(name: string, raw: Record<string, any> | null): TechEntry {
  const data = raw ?? {};
  return {
    name,
    template: data.template ?? null,
    base_tech: data.base_tech ?? null,
    active: data.active !== false,
    extraParams: Object.entries(data)
      .filter(([key]) => !TECH_PROMOTED.has(key))
      .map(([key, value]) => ({ key, value })),
  };
}

export function techToRaw(entry: TechEntry): Record<string, any> {
  const result: Record<string, any> = {};
  if (entry.active === false) result.active = false;
  if (entry.template) result.template = entry.template;
  if (entry.base_tech) result.base_tech = entry.base_tech;
  return { ...result, ...paramsToObject(entry.extraParams) };
}

// ── Links ───────────────────────────────────────────────────────────────────

export interface LinkEntry {
  name: string;
  linkFrom: string;
  linkTo: string;
  template: string | null;
  active: boolean;
  params: Param[];
}

/** Fields the links form promotes; `base_tech` is implied by being a link. */
const LINK_PROMOTED = new Set([
  "link_from",
  "link_to",
  "template",
  "active",
  "base_tech",
]);

export function rawToLink(name: string, raw: RawTech): LinkEntry {
  const data = raw ?? {};
  return {
    name,
    linkFrom: data.link_from ?? "",
    linkTo: data.link_to ?? "",
    template: data.template ?? null,
    active: data.active !== false,
    params: Object.entries(data)
      .filter(([key]) => !LINK_PROMOTED.has(key))
      .map(([key, value]) => ({ key, value })),
  };
}

/**
 * @param templates Resolved templates, to see whether the chosen one already makes
 *   this a transmission technology. Without them the rule was "assume a template
 *   supplies `base_tech`", which is wrong for a template that only sets costs and
 *   writes a link Calliope does not treat as one. Unknown template names still get
 *   an explicit `base_tech`: a redundant key is noise, a missing one is a broken
 *   model.
 */
export function linkToRaw(
  entry: LinkEntry,
  templates: Record<string, Record<string, any>> = {},
): Record<string, any> {
  const result: Record<string, any> = {};
  if (entry.active === false) result.active = false;
  if (entry.template) result.template = entry.template;
  if (entry.linkFrom) result.link_from = entry.linkFrom;
  if (entry.linkTo) result.link_to = entry.linkTo;
  const inherited =
    entry.template && templates[entry.template]?.base_tech === "transmission";
  if (!inherited) result.base_tech = "transmission";
  return { ...result, ...paramsToObject(entry.params) };
}

// ── Nodes ───────────────────────────────────────────────────────────────────

export interface TechOverride {
  techName: string;
  params: Param[];
}

export interface NodeEntry {
  name: string;
  template: string | null;
  active: boolean;
  latitude: number | null;
  longitude: number | null;
  extraParams: Param[];
  techs: TechOverride[];
}

const NODE_PROMOTED = new Set(["active", "latitude", "longitude", "techs", "template"]);

export function rawToNode(name: string, raw: Record<string, any> | null): NodeEntry {
  const data = raw ?? {};
  return {
    name,
    template: data.template ?? null,
    active: data.active !== false,
    latitude: data.latitude ?? null,
    longitude: data.longitude ?? null,
    extraParams: Object.entries(data)
      .filter(([key]) => !NODE_PROMOTED.has(key))
      .map(([key, value]) => ({ key, value })),
    techs: Object.entries(
      (data.techs ?? {}) as Record<string, Record<string, any> | null>,
    ).map(([techName, params]) => ({
      techName,
      params: objectToParams(params),
    })),
  };
}

export function nodeToRaw(entry: NodeEntry): Record<string, any> {
  const result: Record<string, any> = {};
  if (entry.active === false) result.active = false;
  if (entry.template) result.template = entry.template;
  if (entry.latitude !== null) result.latitude = entry.latitude;
  if (entry.longitude !== null) result.longitude = entry.longitude;
  Object.assign(result, paramsToObject(entry.extraParams));

  const techs: Record<string, any> = {};
  for (const override of entry.techs) {
    if (!override.techName) continue;
    const params = paramsToObject(override.params);
    // A technology with no overrides is `tech_name:` with nothing under it —
    // which is how a model says "this node has this technology, as defined".
    techs[override.techName] = Object.keys(params).length ? params : null;
  }
  if (Object.keys(techs).length) result.techs = techs;

  return result;
}

/**
 * A stable key for one row of a list edited in place.
 *
 * This used to have a sibling, `entryKey`, which keyed an *entry* on its name
 * and fell back to its index — and the name is the one field of an entry the
 * form lets you change. Every keystroke in a name box therefore changed the key
 * of the row being typed in: Vue unmounted it, focus went to the document, and
 * the accordion row collapsed, so naming a technology took one click per
 * character. Identity is the only thing about a row that does not change while
 * it is being edited, so it is the only honest key.
 *
 * A parameter row has the same problem for a different reason: it has no name
 * to key on at all until somebody types one, so those lists were keyed by array
 * index — and removing a row made Vue *reuse* the component that had been
 * showing the row above it. `ScalarOrDataVar` reads its props once at setup, so
 * the reused instance kept the removed row's value while the key input showed
 * the new one's, and the next change wrote that value under the new key: a
 * wrong number in the user's model, indistinguishable from one they typed.
 *
 * A `WeakMap` rather than a field on the row, so the identity is invisible to
 * `paramsToObject` and cannot be written into anybody's YAML, and so a removed
 * row's entry is collected with it. Vue hands out one reactive proxy per raw
 * object, so a row reached through `entries.value[i]` is the same object on
 * every render and keys to the same string.
 */
const rowKeys = new WeakMap<object, string>();
let nextRowKey = 0;

export function rowKey(row: object): string {
  let key = rowKeys.get(row);
  if (key === undefined) {
    key = `row-${(nextRowKey += 1)}`;
    rowKeys.set(row, key);
  }
  return key;
}

/**
 * The name a row was loaded under, so a save can say what was renamed.
 *
 * A rename used to reach the server as a delete and an add, which put the
 * entry at the end of its section and lost every comment in its block, since
 * the server rebuilds an unknown key from plain JSON. It now travels as
 * `{new: old}` beside the section, and the row is the only thing that knows
 * both names. A `WeakMap` for the reason `rowKey` is one: the serialisers must
 * not see it, and a removed row takes its entry with it. Keyed on the row as
 * the editor reaches it through `entries.value` — one reactive proxy per
 * object, the rule `rowKey` already rests on — and refreshed after a save,
 * because the file then says the new name.
 */
const loadedNames = new WeakMap<object, string>();

export function rememberName(row: object, name: string): void {
  loadedNames.set(row, name);
}

export function loadedName(row: object): string | undefined {
  return loadedNames.get(row);
}

/**
 * `{new: old}` for every row whose name has changed since it was loaded.
 *
 * A row added this session has no loaded name and is an addition, not a
 * rename. A row renamed onto a name another entry still holds is reported all
 * the same: the server refuses the collision, which beats the silent overwrite
 * a plain section write would be.
 */
export function renamesFor(rows: readonly { name: string }[]): Record<string, string> {
  const renames: Record<string, string> = {};
  for (const row of rows) {
    const was = loadedNames.get(row);
    if (was === undefined || was === row.name || !row.name) continue;
    renames[row.name] = was;
  }
  return renames;
}
