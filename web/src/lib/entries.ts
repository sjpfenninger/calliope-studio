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
  const asNumber = Number(trimmed);
  return isNaN(asNumber) ? trimmed : asNumber;
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
 * A stable key for one entry in an editor's list.
 *
 * The five structured editors each spelled this out three times — in
 * `:default-value`, `:key` and `:value` — which is fifteen copies of an
 * expression that has to agree everywhere or an accordion row desyncs from the
 * data underneath it. An unnamed entry falls back to its position, which is the
 * best available answer while someone is still typing the name.
 */
export function entryKey(
  entry: { name?: string },
  all: readonly { name?: string }[],
): string {
  return entry.name || String(all.indexOf(entry as never));
}

/**
 * A stable key for one row of a list edited in place.
 *
 * `entryKey` keys on the name, which every entity form has. A parameter row has
 * no name until somebody types one, and the lists were keyed by array index
 * instead — so removing a row made Vue *reuse* the component that had been
 * showing the row above it. `ScalarOrDataVar` reads its props once at setup, so
 * the reused instance kept the removed row's value while the key input showed
 * the new one's, and the next change wrote that value under the new key: a
 * wrong number in the user's model, indistinguishable from one they typed.
 *
 * A `WeakMap` rather than a field on the row, so the identity is invisible to
 * `paramsToObject` and cannot be written into anybody's YAML, and so a removed
 * row's entry is collected with it.
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
