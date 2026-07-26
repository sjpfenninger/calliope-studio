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

/** A full timestamp, for the `title` of anything showing a relative one. */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "—" : new Date(at).toLocaleString();
}
