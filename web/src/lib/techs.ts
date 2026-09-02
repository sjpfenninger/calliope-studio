/**
 * Telling transmission technologies apart from the rest.
 *
 * Calliope 0.7 has no `links:` section: a transmission link is an ordinary
 * entry under `techs:` carrying `link_from` and `link_to`. The editor presents
 * the two kinds separately because they are edited differently — a link is
 * defined by the two nodes it joins — but they share one YAML section, so both
 * editors have to write the whole of it back.
 */

export const LINK_KEYS = ["link_from", "link_to"] as const;

export type RawTech = Record<string, any> | null;

/**
 * Whether an entry is a transmission link.
 *
 * `base_tech` is usually inherited from a template, so the template has to be
 * applied before asking. Endpoints are checked too: an entry naming both is
 * unmistakably a link even if its template is missing or unreadable.
 */
export function isTransmission(
  raw: RawTech,
  templates: Record<string, Record<string, any>> = {},
): boolean {
  if (!raw) return false;
  const template = raw.template ? (templates[raw.template] ?? {}) : {};
  const baseTech = raw.base_tech ?? template.base_tech;
  if (baseTech === "transmission") return true;
  return LINK_KEYS.every((key) => Boolean(raw[key] ?? template[key]));
}


/**
 * The names one of the two editors owns, decided once when the section loads.
 *
 * Ownership must not be re-derived from what a save wrote, and that is the
 * whole reason this exists as a snapshot rather than a predicate. `base_tech`
 * is a field the techs form can *set*: choosing `transmission` for a technology
 * and saving made the very next ownership question answer "no" for a row still
 * on screen and still in `entries`, so `mergeIntoSection` passed the pre-edit
 * original through and every later edit to that row was discarded — silently,
 * with the tab marked clean each time.
 *
 * Reclassifying is a load-time act. A reload is where an entry moves from one
 * editor to the other.
 */
export function ownedNames(
  section: Record<string, RawTech>,
  templates: Record<string, Record<string, any>>,
  kind: "techs" | "links",
): Set<string> {
  const wantsLinks = kind === "links";
  return new Set(
    Object.keys(section).filter(
      (name) => isTransmission(section[name] ?? null, templates) === wantsLinks,
    ),
  );
}


/**
 * Rebuilds a full `techs:` section from one editor's partial edits.
 *
 * Both editors show half the section and both save the whole file, so an editor
 * that wrote only what it displayed would delete the other half. Entries this
 * editor does not own are passed through untouched, and the original key order
 * is kept so saving does not reshuffle the file.
 */
export function mergeIntoSection(
  original: Record<string, RawTech>,
  edited: Record<string, RawTech>,
  owned: (name: string) => boolean,
): Record<string, RawTech> {
  const merged: Record<string, RawTech> = {};

  for (const [name, raw] of Object.entries(original)) {
    if (!owned(name)) {
      merged[name] = raw;
    } else if (name in edited) {
      merged[name] = edited[name];
    }
    // An owned entry missing from `edited` was deleted in the editor.
  }

  for (const [name, raw] of Object.entries(edited)) {
    if (!(name in merged)) merged[name] = raw;
  }

  return merged;
}
