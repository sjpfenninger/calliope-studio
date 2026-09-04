import type { CompareSide } from "@/api/compare";

/** What the Model half says when it has no diff to show. */
export interface CompareStatus {
  tone: "info" | "warning" | "danger";
  text: string;
  /** Calliope's own complaint, where there is one. */
  detail?: string;
  /** Whether an answer is still coming, so the view shows it as work. */
  loading: boolean;
}

/**
 * Turns the server's account of two sides into a line the user can act on.
 *
 * A comparison has two sides and either can be the problem, so the message has
 * to name *which* — "the current model" and "this run" are different things to
 * go and fix, and a single "could not compare" leaves somebody guessing.
 *
 * The pattern is `lib/geoStatus.ts`'s, and for the same reason: wording that
 * exists only inside a template is wording nothing can test, and the states
 * here are exactly the ones that are awkward to reproduce by hand.
 */
export function compareStatus(
  a: CompareSide | null,
  b: CompareSide | null,
  pending: boolean,
  reason?: string | null,
  gaveUp = false,
): CompareStatus | null {
  const sides: Array<[CompareSide | null, string]> = [
    [a, "before"],
    [b, "after"],
  ];

  if (pending && gaveUp) {
    return {
      tone: "warning",
      text: "Calliope is still reading the model after a minute. Refresh to keep waiting.",
      loading: false,
    };
  }

  if (pending) {
    return {
      tone: "info",
      text: "Reading the model with Calliope. This takes a few seconds.",
      loading: true,
    };
  }

  for (const [side, position] of sides) {
    if (!side || side.model.source !== "unavailable") continue;
    const detail = side.model.resolve_error ?? undefined;
    return {
      tone: "danger",
      text: `Calliope cannot read ${describe(side, position)}:`,
      detail: detail ?? side.model.reason ?? reason ?? undefined,
      loading: false,
    };
  }

  // No `stale` case: the server never diffs one and reports it as
  // `unavailable` with a reason, which the loop above has already answered.

  const unknown = sides.find(([side]) => side && !side.scenario_known);
  if (unknown) {
    const [side] = unknown;
    return {
      tone: "warning",
      text: `This model no longer defines a scenario called ${side!.scenario}.`,
      loading: false,
    };
  }

  return null;
}

function describe(side: CompareSide, position: string): string {
  if (side.kind === "run") return `the run compared as ${position}`;
  return side.scenario
    ? `the current model with ${side.scenario} applied`
    : "the current model";
}
