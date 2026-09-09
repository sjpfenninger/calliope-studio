/**
 * Which version of a model a side of a comparison is.
 *
 * Spelled `workspace`, `workspace@{scenario}`, `run.{runId}`, `head` or
 * `commit.{sha}`. Two separators,
 * neither of them a colon: a compare tab's id is `compare:{a}:{b}` and
 * `parseTabId` splits on `:`, so a colon inside a reference would silently
 * split it into the wrong number of segments. A scenario legitimately contains
 * commas, because Calliope's `scenario=` also accepts a joined list of override
 * names, so nothing here may split on one.
 *
 * The Python twin is `server/compare.py`; `tests/test_compare_api.py` and
 * `compareRef.test.ts` share a table of spellings so the two cannot drift.
 *
 * `parseRef` returns null for an unknown kind rather than throwing: a URL
 * outlives the scheme that wrote it.
 */

export type CompareRef =
  | { kind: "workspace"; scenario: string | null }
  | { kind: "run"; runId: string }
  /** The last commit, resolved to a sha by the server. */
  | { kind: "head" }
  | { kind: "commit"; sha: string };

/** Mirrors `SHA_RE` in src/calliope_studio/vcs/repo.py. */
const SHA = /^[0-9a-f]{4,40}$/i;

export function formatRef(ref: CompareRef): string {
  if (ref.kind === "run") return `run.${ref.runId}`;
  if (ref.kind === "head") return "head";
  if (ref.kind === "commit") return `commit.${ref.sha}`;
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
  // A commit is the folder as it was, read as written: no scenario either.
  if (kind === "head") return rest || scenario ? null : { kind: "head" };
  if (kind === "commit") {
    return rest && !scenario && SHA.test(rest) ? { kind: "commit", sha: rest } : null;
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

export const headRef = (): CompareRef => ({ kind: "head" });

export const commitRef = (sha: string): CompareRef => ({ kind: "commit", sha });

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
  if (ref.kind === "head") return label ? `Commit ${label}` : "Last commit";
  if (ref.kind === "commit") return `Commit ${label ?? ref.sha.slice(0, 7)}`;
  return ref.scenario ? `Model @${ref.scenario}` : "Model";
}
