/**
 * How the size of an optimisation problem reads.
 *
 * Two renderings of one wire shape, in one module because three components show
 * it — the run tab's header while a solve is running, its config pane once the
 * run is over, and the validation tab for a model that was built but never
 * solved. Three copies of "5.1k × 6.4k" is how the same figure comes to appear
 * in two spellings a click apart.
 *
 * **These are pre-presolve counts**, which is why `PROBLEM_SIZE_HINT` exists and
 * why every display of them carries it: the solver reports its own, smaller,
 * numbers in its log, and a user comparing the two without being told which is
 * which would reasonably conclude one of them is wrong.
 */
import type { ProblemSize } from "@/api/runs";

import { formatCompact, formatCount } from "./format";

/** Said wherever the compact form is shown, because the compact form cannot. */
export const PROBLEM_SIZE_HINT =
  "Variables × constraints, as Calliope built them. The solver's presolve reduces both.";

/** Whether there is anything to show: a run that never built has nothing. */
export function hasProblemSize(problem: ProblemSize | null | undefined): boolean {
  return Boolean(problem && (problem.variables || problem.constraints));
}

/**
 * The header form: `5.1k × 6.4k`, or `5.1k × 6.4k · 339 int` for a MILP.
 *
 * Compact because it sits in a strip already carrying a status pill, the stage
 * progress, a level select, the solver, the objective, the duration and a Cancel
 * button. The multiplication sign is not arithmetic — it is the shape of the
 * constraint matrix, which is the thing being described.
 */
export function compactProblemSize(problem: ProblemSize | null | undefined): string | null {
  if (!hasProblemSize(problem)) return null;
  const shape = `${formatCompact(problem?.variables ?? 0)} × ${formatCompact(problem?.constraints ?? 0)}`;
  const integers = problem?.integer_variables ?? 0;
  return integers > 0 ? `${shape} · ${formatCompact(integers)} int` : shape;
}

/**
 * The prose form, for somewhere with room for it.
 *
 * Full digits rather than compact: this is read once, not scanned in a column,
 * and "5,066" is the number a user would quote in an issue.
 */
export function describeProblemSize(problem: ProblemSize | null | undefined): string | null {
  if (!hasProblemSize(problem)) return null;
  const sentence = [
    formatCount(problem?.variables ?? 0, "variable"),
    formatCount(problem?.constraints ?? 0, "constraint"),
  ].join(" and ");
  const integers = problem?.integer_variables ?? 0;
  return integers > 0
    ? `${sentence}, ${integers.toLocaleString()} of them integer`
    : sentence;
}
