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

export function linkToRaw(entry: LinkEntry): Record<string, any> {
  const result: Record<string, any> = {};
  if (entry.active === false) result.active = false;
  if (entry.template) result.template = entry.template;
  if (entry.linkFrom) result.link_from = entry.linkFrom;
  if (entry.linkTo) result.link_to = entry.linkTo;
  // Only when not inherited, so a link using a template does not gain a
  // redundant `base_tech` it never had.
  if (!entry.template) result.base_tech = "transmission";
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
