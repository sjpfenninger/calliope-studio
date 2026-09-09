/**
 * Runs: `/api/runs/{id}/`, and the version-scoped list and start.
 *
 * `RunRecord` lives here because it is a wire shape. It was declared in full in
 * `stores/runs.ts` and again, structurally and with three of its twenty-eight
 * fields, in `views/OpenResultsView.vue` — the second copy being what a store
 * with no module to import from produces.
 */
import client from "./client";
import { filePath, seg } from "./paths";
import type { CsvPayload, FileEntry } from "./versions";

/** Matches `TERMINAL_STATUSES` in src/calliope_studio/runs/manager.py. */
export type RunStatus =
  | "pending"
  | "running"
  | "success"
  | "infeasible"
  | "failed"
  | "cancelled";

/**
 * How big the optimisation problem the backend assembled is.
 *
 * Counted as Calliope built it, **before the solver's presolve** — the solver
 * reports its own, smaller, numbers. Anything displaying these has to say which
 * they are. Empty for a run that never reached a build.
 *
 * Mirrors `summarise` in src/calliope_studio/runs/problem.py.
 */
export interface ProblemSize {
  variables?: number;
  constraints?: number;
  piecewise_constraints?: number;
  global_expressions?: number;
  integer_variables?: number;
  /** `{group: {component name: count}}`, largest first, for variables and
   * constraints only. */
  components?: Record<string, Record<string, number>>;
}

/**
 * Which commit the model was at when the run started.
 *
 * `dirty` means the tree held uncommitted edits when it was read, so the sha
 * names something near what ran rather than exactly it. Mirrors
 * `_checkpoint` in src/calliope_studio/server/routes/runs.py.
 */
export interface RunGit {
  sha: string;
  short: string;
  branch: string | null;
  dirty: boolean;
}

/** One run, as `RunManager.get` derives it from the run directory. */
export interface RunRecord {
  id: string;
  status: RunStatus;
  created_at: string;

  label: string | null;
  workspace: string | null;
  scenario: string | null;
  override_dict: Record<string, unknown>;
  build_only: boolean;
  /** Null for a folder git says nothing about, and for runs made before it was kept. */
  git: RunGit | null;

  started_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  termination_condition: string | null;
  /** `config.build.backend`; null on a run recorded before it was kept. */
  backend: string | null;
  /** `config.solve.solver`, only when the backend is pyomo; the others do not read it. */
  solver: string | null;
  objective: number | null;
  timings: Record<string, number>;
  error: string | null;
  traceback: string | null;

  /** Written the moment the build finishes, so it is populated while a run is
   * still solving — which is the state it is for. */
  problem: ProblemSize;

  has_results: boolean;
  has_snapshot: boolean;
  snapshot_complete: boolean | null;
  solved_from: string | null;
  size_bytes: number;
  /** Minted by the server for a run that produced results; null otherwise. */
  results_handle: string | null;
}

export async function listRuns(versionId: string): Promise<RunRecord[]> {
  const res = await client.get<RunRecord[]>(`/api/versions/${seg(versionId)}/runs/`);
  return res.data;
}

export async function startRun<O>(versionId: string, options: O): Promise<RunRecord> {
  const res = await client.post<RunRecord>(
    `/api/versions/${seg(versionId)}/runs/`,
    options,
  );
  return res.data;
}

export async function getRun(runId: string): Promise<RunRecord> {
  const res = await client.get<RunRecord>(`/api/runs/${seg(runId)}/`);
  return res.data;
}

export async function cancelRun(runId: string): Promise<RunRecord> {
  const res = await client.post<RunRecord>(`/api/runs/${seg(runId)}/cancel/`);
  return res.data;
}

export async function renameRun(runId: string, label: string): Promise<RunRecord> {
  const res = await client.patch<RunRecord>(`/api/runs/${seg(runId)}/`, { label });
  return res.data;
}

export async function deleteRun(runId: string): Promise<void> {
  await client.delete(`/api/runs/${seg(runId)}/`);
}

/** Where the log stream lives. Consumed by `EventSource`, not by axios. */
export function runLogsUrl(runId: string): string {
  return `/api/runs/${seg(runId)}/logs/`;
}

// ---------------------------------------------------------------------------
// The frozen snapshot a run solved
// ---------------------------------------------------------------------------

export async function getSnapshot<T>(runId: string): Promise<T> {
  const res = await client.get<T>(`/api/runs/${seg(runId)}/snapshot/`);
  return res.data;
}

export async function listSnapshotFiles(runId: string): Promise<FileEntry[]> {
  const res = await client.get<FileEntry[]>(`/api/runs/${seg(runId)}/files/`);
  return res.data;
}

export async function getSnapshotFile(runId: string, path: string): Promise<string> {
  const res = await client.get<{ content: string }>(
    `/api/runs/${seg(runId)}/files/${filePath(path)}`,
  );
  return res.data.content;
}

export async function getSnapshotCsv(
  runId: string,
  path: string,
): Promise<CsvPayload> {
  const res = await client.get<CsvPayload>(
    `/api/runs/${seg(runId)}/csv/${filePath(path)}`,
  );
  return res.data;
}
