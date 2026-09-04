/**
 * Which version of a model a side of a comparison is.
 *
 * Spelled `workspace`, `workspace@{scenario}` or `run.{runId}`. Two separators,
 * neither of them a colon: a compare tab's id is `compare:{a}:{b}` and
 * `parseTabId` splits on `:`, so a colon inside a reference would silently
 * split it into the wrong number of segments. A scenario legitimately contains
 * commas, because Calliope's `scenario=` also accepts a joined list of override
 * names, so nothing here may split on one.
 *
 * The Python twin is `server/compare.py`; `tests/test_compare_api.py` and
 * `compareRef.test.ts` share a table of spellings so the two cannot drift.
 *
 * The grammar has room for the kinds version tracking will add — `head`,
 * `commit.{sha}` — which is why `parseRef` returns null for an unknown kind
 * rather than throwing: a URL outlives the scheme that wrote it.
 */

export type CompareRef =
  | { kind: "workspace"; scenario: string | null }
  | { kind: "run"; runId: string };

export function formatRef(ref: CompareRef): string {
  if (ref.kind === "run") return `run.${ref.runId}`;
  return ref.scenario ? `workspace@${ref.scenario}` : "workspace";
}

export function parseRef(text: string): CompareRef | null {
  if (!text || text.includes(":")) return null;

  const at = text.indexOf("@");
  const head = at === -1 ? text : text.slice(0, at);
  // Only the first `@` splits: a scenario name may contain another.
  const scenario = at === -1 ? "" : text.slice(at + 1);

  const dot = head.indexOf(".");
  const kind = dot === -1 ? head : head.slice(0, dot);
  const rest = dot === -1 ? "" : head.slice(dot + 1);

  if (kind === "workspace") {
    return rest ? null : { kind: "workspace", scenario: scenario || null };
  }
  if (kind === "run") {
    // A run solved what it solved; it cannot be re-read under another scenario.
    return rest && !scenario ? { kind: "run", runId: rest } : null;
  }
  return null;
}

/** The cache key for a pair, which is also the ordering: `a` is *before*. */
export const refKey = (a: CompareRef, b: CompareRef): string =>
  `${formatRef(a)}:${formatRef(b)}`;

export const workspaceRef = (scenario: string | null = null): CompareRef => ({
  kind: "workspace",
  scenario,
});

export const runRef = (runId: string): CompareRef => ({ kind: "run", runId });

/**
 * The same side under a different scenario.
 *
 * Only a workspace has one to change: the header's picker is shown for that
 * side alone, and a run's scenario is a fact about what it solved.
 */
export function withScenario(ref: CompareRef, scenario: string | null): CompareRef {
  return ref.kind === "workspace" ? workspaceRef(scenario) : ref;
}

/** What the tab bar and the header call a side, before the server has answered. */
export function describeRef(ref: CompareRef, label?: string): string {
  if (ref.kind === "run") return label ?? `Run ${ref.runId.slice(0, 8)}`;
  return ref.scenario ? `Model @${ref.scenario}` : "Model";
}
