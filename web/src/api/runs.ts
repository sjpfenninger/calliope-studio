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

  started_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  termination_condition: string | null;
  solver: string | null;
  objective: number | null;
  timings: Record<string, number>;
  error: string | null;
  traceback: string | null;

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
