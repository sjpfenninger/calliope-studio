/**
 * What a result is measured in, and what the reader wants to see it in.
 *
 * Calliope declares a `unit:` for every parameter, variable and global
 * expression, but they are *generalised quantities* — `energy`, `power`,
 * `cost` — never real ones. Calliope has no idea whether a model's flows are
 * kWh or GWh, because nothing in a model definition says so. Only the modeller
 * knows, so only the modeller can say: a scale factor and a label per quantity,
 * from which everything else here is derived.
 *
 * The strings arrive exactly as Calliope writes them, and Calliope writes them
 * three ways at once — all of these are in the installed version, and the last
 * three are on parameters of the sample models:
 *
 *   power            energy.            unitless.
 *   $\text{area}$    $\text{hour}^{-1}$
 *   $\frac{\text{cost}}{\text{hour}}$
 *   $\frac{\{cost}}{\text{power}\times\text{distance}}$      <- upstream typo
 *   energy | $\frac{\text{energy}}{\text{power}}$ | ...      <- ambiguous
 *
 * So this parses rather than looks up. Parsing also buys the composites for
 * nothing: with cost set to "M€" and energy to "GWh", a `cost/energy` parameter
 * scales by both and reads "M€/GWh" without anyone configuring it.
 */
import type { ResultFrame } from "../api/results";

/** The quantities a user can put a real unit to, in the order they are offered. */
export const QUANTITIES = ["energy", "power", "cost", "area", "distance"] as const;

export type Quantity = (typeof QUANTITIES)[number];

const SETTABLE: ReadonlySet<string> = new Set(QUANTITIES);

/**
 * Bases with a unit of their own that no model changes.
 *
 * An hour is an hour whatever the flows are measured in, so these are never
 * offered as settings — but they still have to render, or `cost/hour` would
 * come out as "cost/" and read as a bug.
 */
const FIXED_LABELS: Record<string, string> = {
  hour: "h",
  year: "yr",
  unit: "unit",
};

/** Bases that carry no dimension at all, and so drop out of a unit entirely. */
const DIMENSIONLESS: ReadonlySet<string> = new Set([
  "",
  "1",
  "unitless",
  "integer",
  "fraction",
  "percentage",
]);

/** Written in the plural in some declarations and the singular in others. */
const SINGULAR: Record<string, string> = {
  hours: "hour",
  years: "year",
  units: "unit",
};

/** One base quantity and the power it is raised to. Negative is a denominator. */
export interface UnitTerm {
  base: string;
  exponent: number;
}

/** What a user has said about one quantity. `scale` is kept as they typed it. */
export interface UnitPref {
  scale: string;
  label: string;
}

export type UnitPrefs = Partial<Record<Quantity, UnitPref>>;

/** A resolved unit: what to multiply by, and what to call the result. */
export interface DisplayUnit {
  factor: number;
  label: string;
}

/** No unit known, or none that can safely be scaled. */
export const NO_UNIT: DisplayUnit = { factor: 1, label: "" };

/**
 * More than one unit declared for one component, e.g. `sink_use_equals`, whose
 * unit depends on which of three ways its technology was configured.
 *
 * Both spellings occur. Neither is a unit, and picking the first would mean
 * silently multiplying someone's numbers by a factor chosen at random.
 */
const AMBIGUOUS = /\s\|\s|\sor\s/;

/** Reads a balanced `{…}` starting at `start`, or null if it is not one. */
function readGroup(
  text: string,
  start: number,
): { body: string; end: number } | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

function normaliseBase(word: string): string {
  const base = word.trim().toLowerCase().replace(/\.+$/, "");
  return SINGULAR[base] ?? base;
}

/** One factor of a product: `\text{power}`, `\{cost}`, `hour^{-1}`, `1`. */
function parseAtom(atom: string, sign: number, out: UnitTerm[]): boolean {
  let text = atom.trim();
  if (!text) return true;

  let exponent = 1;
  const caret = text.indexOf("^");
  if (caret >= 0) {
    let power = text.slice(caret + 1).trim();
    const group = readGroup(power, 0);
    if (group) {
      if (power.slice(group.end).trim()) return false;
      power = group.body.trim();
    }
    const value = Number(power);
    if (!Number.isInteger(value)) return false;
    exponent = value;
    text = text.slice(0, caret).trim();
  }

  if (text.startsWith("\\text")) {
    const group = readGroup(text, "\\text".length);
    if (!group || text.slice(group.end).trim()) return false;
    text = group.body;
  } else if (text.startsWith("\\{")) {
    // `\{cost}` for `\text{cost}`, on nine of Calliope's cost parameters.
    const group = readGroup(text, 1);
    if (!group || text.slice(group.end).trim()) return false;
    text = group.body;
  } else if (text.startsWith("\\")) {
    return false;
  }

  const base = normaliseBase(text);
  if (DIMENSIONLESS.has(base)) return true;
  // An unrecognised word is kept rather than rejected: a user's own math may
  // declare `tonnes`, and an axis reading "tonnes" is better than a blank one.
  // It simply has no setting, so it never scales.
  if (!/^[\w-]+$/.test(base)) return false;
  out.push({ base, exponent: sign * exponent });
  return true;
}

function parseExpression(expr: string, sign: number, out: UnitTerm[]): boolean {
  const text = expr.trim();
  if (!text) return true;

  if (text.startsWith("\\frac")) {
    const numerator = readGroup(text, "\\frac".length);
    if (!numerator) return false;
    const denominator = readGroup(text, numerator.end);
    if (!denominator) return false;
    if (text.slice(denominator.end).trim()) return false;
    return (
      parseExpression(numerator.body, sign, out) &&
      parseExpression(denominator.body, -sign, out)
    );
  }

  return text
    .split(/\\times|\\cdot|\*/)
    .every((atom) => parseAtom(atom, sign, out));
}

/**
 * A Calliope unit string as base quantities and their powers.
 *
 * Returns null when the declaration is ambiguous or cannot be read, which is
 * the signal not to scale: `[]` means "dimensionless", which is a real and
 * different answer.
 *
 * Equivalent spellings must collapse. `$\text{hour}^{-1}$` and
 * `$\frac{1}{\text{hour}}$` are the same unit and Calliope uses both.
 */
export function parseUnit(raw: string | null | undefined): UnitTerm[] | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text || AMBIGUOUS.test(text)) return null;

  // A trailing full stop is prose, and it sits outside the maths as often as in.
  const stripped = text.replace(/\.+$/, "").trim();
  const inner = stripped.startsWith("$")
    ? stripped.replace(/^\$+/, "").replace(/\$+$/, "")
    : stripped;

  const terms: UnitTerm[] = [];
  if (!parseExpression(inner, 1, terms)) return null;

  // `energy/energy` is dimensionless, and two mentions of one base are one term.
  const merged: UnitTerm[] = [];
  for (const term of terms) {
    const existing = merged.find((other) => other.base === term.base);
    if (existing) existing.exponent += term.exponent;
    else merged.push({ ...term });
  }
  return merged.filter((term) => term.exponent !== 0);
}

/**
 * A scale as the user typed it — `1000`, `/1000`, `*100`, `1e-3`, `` — as the
 * number to multiply by. Null when it is not a scale.
 *
 * `/1000` is accepted because "divide energy by a thousand" is how anyone would
 * say it, and making them work out that it means 0.001 is a needless sum.
 * Zero is refused: it is never meant, and it silently flattens every chart.
 */
export function parseScale(text: string): number | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return 1;
  const match = /^([*x×/÷])?\s*(.+)$/.exec(trimmed);
  if (!match) return null;
  const value = Number(match[2]);
  if (!Number.isFinite(value) || value === 0) return null;
  return match[1] === "/" || match[1] === "÷" ? 1 / value : value;
}

function scaleOf(base: string, prefs: UnitPrefs): number {
  if (!SETTABLE.has(base)) return 1;
  return parseScale(prefs[base as Quantity]?.scale ?? "") ?? 1;
}

function labelOf(base: string, prefs: UnitPrefs): string {
  if (SETTABLE.has(base)) {
    const chosen = prefs[base as Quantity]?.label?.trim();
    // Falls back to the generalised name, so an axis reads "energy" until it is
    // told better — honest about what Calliope knows, and it shows the setting
    // exists.
    if (chosen) return chosen;
  }
  return FIXED_LABELS[base] ?? base;
}

function part(term: UnitTerm, prefs: UnitPrefs): string {
  const power = Math.abs(term.exponent);
  return power > 1
    ? `${labelOf(term.base, prefs)}^${power}`
    : labelOf(term.base, prefs);
}

/** Renders terms as `a·b/c`, or `1/c` when everything is in the denominator. */
export function composeLabel(terms: UnitTerm[], prefs: UnitPrefs): string {
  if (!terms.length) return "";
  const above = terms.filter((term) => term.exponent > 0);
  const below = terms.filter((term) => term.exponent < 0);
  const top = above.length ? above.map((term) => part(term, prefs)).join("·") : "1";
  if (!below.length) return top;
  return `${top}/${below.map((term) => part(term, prefs)).join("·")}`;
}

/**
 * What to multiply a variable's values by, and what to label them.
 *
 * A unit that cannot be read, or that Calliope declares more than one of, is
 * left alone entirely — factor 1 and no label. Guessing which of three
 * alternatives `sink_use_equals` means and then multiplying by it would be a
 * wrong number presented as a right one, which is the whole thing this feature
 * exists to prevent.
 */
export function resolveUnit(
  raw: string | null | undefined,
  prefs: UnitPrefs,
): DisplayUnit {
  const terms = parseUnit(raw);
  if (!terms || !terms.length) return NO_UNIT;
  const factor = terms.reduce(
    (total, term) => total * scaleOf(term.base, prefs) ** term.exponent,
    1,
  );
  return { factor, label: composeLabel(terms, prefs) };
}

/**
 * Which settable quantities a model's variables actually involve.
 *
 * So the sidebar offers a distance setting to a model with transmission
 * distances in it, and not to one without.
 */
export function quantitiesIn(units: Record<string, string>): Quantity[] {
  const found = new Set<string>();
  for (const raw of Object.values(units ?? {})) {
    for (const term of parseUnit(raw) ?? []) found.add(term.base);
  }
  return QUANTITIES.filter((quantity) => found.has(quantity));
}

/**
 * A frame with every value multiplied.
 *
 * Returns the frame itself when there is nothing to do, which is the common
 * case: unscaled is the default, and a copy of every series on every batch of
 * every chart would be a real cost for no change.
 */
export function scaleFrame(
  frame: ResultFrame | null,
  factor: number,
): ResultFrame | null {
  if (!frame || factor === 1) return frame;
  return {
    ...frame,
    series: frame.series.map((series) => ({
      ...series,
      values: series.values.map((value) => value * factor) as Float64Array,
    })),
  };
}

/** `label` as a parenthesised suffix for a column header, or nothing. */
export function unitSuffix(unit: DisplayUnit | null | undefined): string {
  return unit?.label ? ` (${unit.label})` : "";
}
