/**
 * What an entry gets from somewhere other than itself.
 *
 * A technology's real definition is spread across three places — the entry, the
 * template it names, and any data table that supplies the parameter — and a form
 * showing only the first is misleading. This used to be answered by a separate
 * table of values rendered below the fields, which meant the same parameter
 * appeared twice on screen and neither copy said whether the other one won.
 *
 * Now each field carries its own answer, so this module has to produce one: for
 * a given key, what would this entry have if it said nothing, and where would it
 * come from.
 *
 * **It does not adjudicate.** Where a template and a data table both supply a
 * key with different values, precedence is *meaning*, and meaning is Calliope's
 * to answer (see the "structure and meaning" rule). So a contested key reports
 * both sources and no value, rather than picking the one that happens to sort
 * first. Showing a confident wrong value is the failure mode this whole design
 * exists to avoid.
 */
import { describeParams, paramSources, type DataTableParam } from "./dataTableParams";
import type { LinkEntry, NodeEntry, TechEntry } from "./entries";

/**
 * One place a value could have come from.
 *
 * The kind is carried rather than inferred, because a name alone cannot answer
 * it: a data table may be called anything at all, including the name of the
 * parameter it supplies, and `flow_cap_max ↳ flow_cap_max` is not a sentence.
 * Both loops below already know which they are building.
 */
export interface InheritedSource {
  name: string;
  kind: "template" | "data_table";
}

export interface Inherited {
  /** The value as a display string, or `null` when the sources disagree. */
  value: string | null;
  /** Where it comes from: a template, or a data table — each by name. */
  sources: InheritedSource[];
}

/** A template's value, as something a field can show as ghost text. */
export function formatInheritedValue(value: any): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Merge what a template and what the data tables supply, by key.
 *
 * @param templateName The template the entry names, or null.
 * @param templateFields That template's own keys, unformatted.
 * @param dataTableParams This entity's data-table parameters, by parameter name.
 */
export function collectInherited(
  templateName: string | null,
  templateFields: Record<string, any> | undefined,
  dataTableParams: Record<string, DataTableParam> | undefined,
): Record<string, Inherited> {
  const result: Record<string, Inherited> = {};

  if (templateName) {
    const from: InheritedSource = { name: templateName, kind: "template" };
    for (const [key, value] of Object.entries(templateFields ?? {})) {
      result[key] = { value: formatInheritedValue(value), sources: [from] };
    }
  }

  const described = describeParams(dataTableParams);
  const sources = paramSources(dataTableParams);
  for (const [key, value] of Object.entries(described)) {
    // An older server sends no `source`, so there is no table to name and
    // nothing to open — the label degrades to plain text rather than a link.
    const source: InheritedSource = {
      name: sources[key] ?? "data table",
      kind: "data_table",
    };
    const existing = result[key];
    if (!existing) {
      result[key] = { value, sources: [source] };
    } else if (existing.value === value) {
      // The same answer twice is not a conflict; say it once, credit both.
      result[key] = { value, sources: [...existing.sources, source] };
    } else {
      result[key] = { value: null, sources: [...existing.sources, source] };
    }
  }

  return result;
}

// ── Which keys an entry sets itself ─────────────────────────────────────────
//
// These decide whether a field offers to revert, so they live here with tests
// rather than as a near-identical private function in each of three forms —
// which is what they were, each quietly disagreeing about `active`.
//
// `template` is never "set over" something inherited: it is the thing doing the
// inheriting. And `active` counts only when it is *false*, because absent means
// active and a form showing the default has not overridden anything.

export function nodeSetsKey(entry: NodeEntry, key: string): boolean {
  if (key === "template") return false;
  if (key === "active") return entry.active === false;
  if (key === "latitude") return entry.latitude !== null;
  if (key === "longitude") return entry.longitude !== null;
  if (key === "techs") return entry.techs.length > 0;
  return entry.extraParams.some((param) => param.key === key);
}

export function techSetsKey(entry: TechEntry, key: string): boolean {
  if (key === "template") return false;
  if (key === "active") return entry.active === false;
  if (key === "base_tech") return entry.base_tech !== null;
  return entry.extraParams.some((param) => param.key === key);
}

export function linkSetsKey(entry: LinkEntry, key: string): boolean {
  if (key === "template") return false;
  if (key === "active") return entry.active === false;
  if (key === "link_from") return entry.linkFrom !== "";
  if (key === "link_to") return entry.linkTo !== "";
  return entry.params.some((param) => param.key === key);
}

/**
 * Inherited keys the form has no field for, and the entry has no parameter for.
 *
 * These are what the old table showed that nothing else would: a template
 * supplying `flow_out_eff` to a node whose form knows nothing about it. They
 * become ghost parameter rows, so folding provenance onto the fields loses
 * nothing.
 */
export function unmatchedInherited(
  inherited: Record<string, Inherited>,
  promoted: Iterable<string>,
  params: { key: string }[],
): string[] {
  const covered = new Set(promoted);
  for (const param of params) covered.add(param.key);
  return Object.keys(inherited)
    .filter((key) => !covered.has(key))
    .sort();
}
