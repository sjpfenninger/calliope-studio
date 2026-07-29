/**
 * The small numbers a run history is made of.
 *
 * Pure, and therefore testable — which matters more than it looks: every one of
 * these is read at a glance in a dense list, so "3.4 MB" versus "3417 kB" and
 * "2m 14s" versus "134.213s" is the difference between a scannable column and a
 * wall of digits.
 */

const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB"];

/** Decimal, not binary: this is disk usage as the operating system reports it. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // Whole bytes are always integers; anything scaled keeps one decimal up to
  // three significant figures, so "13.6 GB" does not collapse into "14 GB".
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/**
 * A run's wall-clock duration.
 *
 * Sub-second solves happen (`build_only`, tiny models), and reporting them as
 * "0s" makes it look like nothing ran.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${rest}s`;
}

/**
 * The objective value, which is the first number anyone comparing two runs looks
 * at — so it is shown at a fixed precision rather than in full float glory.
 */
export function formatObjective(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude >= 1e6 || magnitude < 1e-2)) {
    return value.toExponential(3);
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/**
 * A magnitude in as few characters as it can honestly be written.
 *
 * For the ends of a legend scale, which get about four characters between two
 * swatches. `Intl`'s compact notation does the unit suffixes — 12300 becomes
 * "12K" — and is locale-aware, which hand-rolled thresholds are not.
 *
 * Compact notation has no suffixes going the other way, though, so a solver's
 * numerical dust comes out as "0.0000000131" and pushes the other end of the
 * scale off the legend. Below a thousandth it goes exponential instead, which is
 * both shorter and a clearer way of saying "essentially nothing".
 *
 * `precision` **tightens this and never loosens it**. The reader's rounding
 * setting should not be ignored somewhere as visible as a legend, but nor can it
 * be honoured literally: at twelve significant figures one end of the ramp would
 * be wider than the ramp. Three is the ceiling because three is what fits.
 */
export function formatCompact(
  value: number | null | undefined,
  precision: number | null = null,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  // Capped separately at each end, because the two ends were never equal: the
  // exponential branch has always shown two significant figures and the compact
  // one three. An unset precision has to leave both exactly where they were.
  if (magnitude !== 0 && magnitude < 1e-3) {
    return value.toExponential(Math.min(precision ?? 2, 2) - 1);
  }
  return value.toLocaleString(undefined, {
    notation: "compact",
    maximumSignificantDigits: Math.min(precision ?? 3, 3),
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago something happened, in the coarsest unit that is still true.
 *
 * `now` is a parameter rather than a call to `Date.now()` so the function is
 * pure and can be tested without freezing the clock.
 */
export function formatRelativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";

  const elapsed = now - at;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;

  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * A path shortened from its *head*, keeping the last few segments.
 *
 * Because `truncate` clips the wrong end. Two models under the same tree —
 * `/Users/me/Code/work/grid-a` and `/Users/me/Code/work/grid-b` — both render as
 * `/Users/me/Code/wor…` in a 288px dropdown, which is a path column that
 * distinguishes nothing, and distinguishing is the only reason it is there.
 *
 * Segment-counting rather than measuring text: it needs no layout pass, gives
 * the same answer every render, and is testable. `truncate` stays on the element
 * as the backstop for a single very long segment, and the full path goes in the
 * `title`.
 */
export function shortenPath(path: string | null | undefined, keep: number = 3): string {
  if (!path) return "—";
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= keep) return path;
  return `…/${segments.slice(-keep).join("/")}`;
}

/** A full timestamp, for the `title` of anything showing a relative one. */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "—" : new Date(at).toLocaleString();
}
