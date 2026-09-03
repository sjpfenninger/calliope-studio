/**
 * What went wrong, in one sentence, from anything that can be thrown.
 *
 * There were six idioms for this and the difference was visible to the user, not
 * merely stylistic. The editors read `e?.response?.data?.detail` and so showed
 * the server's own message — "override path `config.init.name.deeper` cannot
 * exist" — while the results and runs surfaces read `(caught as Error).message`,
 * which on an axios rejection is the string "Request failed with status code
 * 500". Same failure, same backend, two entirely different qualities of answer
 * depending on which pane you happened to be looking at.
 *
 * This is the union of the two implementations that were already the best of
 * them: `useCsvGrid`'s, the only one that turned a bare status into something a
 * reader can act on, and `stores/validation`'s, the only one that handled a
 * non-axios `Error` rather than falling through to a generic string. Neither had
 * both halves.
 *
 * `unknown` rather than `any`, because a `catch` binding genuinely is unknown and
 * the ten `catch (e: any)` blocks this replaces were the avoidable third of the
 * `any` in the codebase.
 */

interface Axiosish {
  response?: { status?: number; data?: { detail?: unknown } };
  message?: unknown;
}

/**
 * Args:
 *     caught: Whatever the `catch` bound — an axios rejection, an `Error`, or
 *         something a library threw that is neither.
 *     fallback: What to say when the error carries nothing usable. Name the
 *         action, not the mechanism: "Failed to save scenarios." beats "Error".
 *
 * Returns:
 *     A message fit to put in front of a user.
 */
/**
 * Whether a save was refused because the file changed under it.
 *
 * The one failure a save surface has to treat differently: the server's 409
 * means the buffer is *stale*, not broken, so the fix is a reload rather than
 * a retry — and the message alone cannot carry that distinction to a button.
 */
export function isConflict(caught: unknown): boolean {
  return (caught as Axiosish | null)?.response?.status === 409;
}

export function errorDetail(caught: unknown, fallback: string): string {
  const err = caught as Axiosish | null;

  // FastAPI's own message, and the only one that knows what actually happened.
  const detail = err?.response?.data?.detail;
  if (typeof detail === "string" && detail) return detail;

  // A status with no body still narrows it usefully, and 404 especially so:
  // "File not found." is actionable where "Request failed (404)." is not.
  const status = err?.response?.status;
  if (status === 404) return "Not found.";
  if (status) return `Request failed (${status}).`;

  // Neither an axios rejection nor a status: a TypeError from our own code, or
  // a network failure, both of which say something worth passing on.
  if (caught instanceof Error && caught.message) return caught.message;

  return fallback;
}
