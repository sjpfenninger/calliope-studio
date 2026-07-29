/**
 * How many digits of a result value the reader wants to see.
 *
 * There were four rules and nobody had decided them together: the grid trimmed
 * to ten significant figures, the chart tooltip printed the raw float, the map
 * popup ran it through `toLocaleString()`, and the y-axis took whatever ECharts
 * felt like. One value therefore read as `1234.567891`, `1234.5678901234 GWh`
 * and `1,234.568` depending on where you looked at it — three answers to a
 * question with one answer.
 *
 * This is that one answer. It is deliberately locale-free, like the two rules it
 * replaces that mattered most: a cell and a CSV field are numbers a spreadsheet
 * has to be able to read back, and under a European locale `toLocaleString`
 * renders `1234.5` as `1.234,5`.
 *
 * **Significant figures, not decimal places.** A results frame spans orders of
 * magnitude — a 40 GW capacity sits beside a 0.003 cost fraction, and two decimal
 * places flattens the second to zero while padding the first with digits no
 * solver would call significant.
 */

/**
 * Beyond this a double carries no more information, so the digits are noise.
 *
 * `toPrecision` itself accepts up to 100 and would happily print all of them.
 */
export const MAX_PRECISION = 15;

/**
 * Outside this window a value is written in exponential form.
 *
 * A column of digits nobody can count is not information, in either direction:
 * `13100000000` and `0.0000000131` both take longer to read than the exponent
 * does. Inherited from the grid's original `formatCell`, and shared now so the
 * chart, the map and the table cannot disagree about where the ends are.
 */
const LARGE = 1e9;
const SMALL = 1e-4;

/**
 * Significant figures as the user typed them, or null for "do not round".
 *
 * Null for an empty field *and* for an unreadable one, which is the same
 * forgiveness `lib/units.ts::parseScale` extends: `1` on the way to `12` is the
 * normal state of a field being typed in, and rounding six figures to one digit
 * on the way through would be its own kind of broken. `isBadPrecision` is what
 * tells the two apart for the reader.
 */
export function parsePrecision(text: string | null | undefined): number | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  // `Number` alone accepts `1e3`, ` 4 ` and `0x4`; a count of digits is written
  // in digits.
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (value < 1 || value > MAX_PRECISION) return null;
  return value;
}

/** The user typed something and it is not a precision — for the red border. */
export function isBadPrecision(text: string | null | undefined): boolean {
  return Boolean((text ?? "").trim()) && parsePrecision(text) === null;
}

/**
 * The grid's rule before anyone could ask for anything else.
 *
 * `toPrecision` and back through `Number` is what removes the trailing
 * `0000000004` a float sum leaves behind, without rounding anything a solver
 * would call significant. Kept exactly as it was, down to the five significant
 * figures at the exponential ends not matching the ten in the middle: an unset
 * field must change nothing anywhere, and "nothing" includes the oddities.
 */
const DEFAULT_INLINE = 10;
const DEFAULT_EXPONENT_DIGITS = 4;

/**
 * A result value as text, at the reader's precision.
 *
 * `precision` null — the default, and what an empty field means — is the rule
 * above, so the whole feature is opt-in and costs an untouched app nothing.
 */
export function formatValue(
  value: number | undefined,
  precision: number | null = null,
): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  if (value === 0) return "0";

  const magnitude = Math.abs(value);
  if (magnitude >= LARGE || magnitude < SMALL) {
    // One fewer, because `toExponential`'s argument counts digits *after* the
    // point while `toPrecision`'s counts all of them.
    return value.toExponential(
      precision === null ? DEFAULT_EXPONENT_DIGITS : precision - 1,
    );
  }
  return String(Number(value.toPrecision(precision ?? DEFAULT_INLINE)));
}
