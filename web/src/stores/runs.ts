import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";

import client from "../api/client";
import { useTabsStore } from "./tabs";

/**
 * Every run of the current model, and what each one is doing right now.
 *
 * Replaces `stores/run.ts`, which held a single `activeRun` and one log buffer.
 * That was enough while runs were a side panel with no history, but the shell
 * opens a run in its own tab and several can be open at once, so both the status
 * poll and the log stream have to be per run. A singleton would have made two
 * run tabs overwrite each other's log the moment the second one opened.
 *
 * Everything here is keyed by run id. Nothing is derived from "the current run",
 * because there isn't one.
 */

/** Matches `TERMINAL_STATUSES` in src/calligraph/runs/manager.py. */
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

export interface RunOptions {
  label?: string | null;
  scenario?: string | null;
  override_dict?: Record<string, unknown>;
  build_only?: boolean;
}

/** Which stage the worker last announced, and whether it finished it. */
export interface RunStage {
  name: string;
  status: string;
}

/**
 * Every status the backend considers final.
 *
 * This used to be `{success, failed}`, missing the two the server can actually
 * report as well — so an infeasible or cancelled run was polled every two
 * seconds for ever, and its tab never stopped saying "running".
 */
const TERMINAL_STATUSES = new Set<RunStatus>([
  "success",
  "infeasible",
  "failed",
  "cancelled",
]);

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

const POLL_INTERVAL_MS = 2000;

export const useRunsStore = defineStore("runs", () => {
  const records = reactive(new Map<string, RunRecord>());
  const logs = reactive(new Map<string, string[]>());
  const stages = reactive(new Map<string, RunStage>());
  const streaming = reactive(new Set<string>());
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  // Not reactive: nothing renders a timer or an EventSource, and making them
  // reactive would mean Vue proxying objects the browser handed us.
  const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const streams = new Map<string, EventSource>();

  /** Newest first, which is the only order a history list is ever read in. */
  const ordered = computed(() =>
    [...records.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)),
  );

  const active = computed(() => ordered.value.filter((run) => !isTerminal(run.status)));

  const totalBytes = computed(() =>
    ordered.value.reduce((sum, run) => sum + run.size_bytes, 0),
  );

  function get(runId: string): RunRecord | undefined {
    return records.get(runId);
  }

  function logsFor(runId: string): string[] {
    return logs.get(runId) ?? [];
  }

  /**
   * Records a run, and pushes anything a tab needs to know into the tab store.
   *
   * A run tab is opened the instant the run starts, long before there is
   * anything to plot. Without this the tab would keep showing the log for ever,
   * because nothing else ever learns that a results handle now exists.
   */
  function absorb(record: RunRecord) {
    records.set(record.id, record);
    useTabsStore().updateRun(record.id, {
      handle: record.results_handle,
      label: record.label,
    });
    return record;
  }

  // -- status ----------------------------------------------------------------

  async function refresh(runId: string): Promise<RunRecord | null> {
    try {
      const res = await client.get<RunRecord>(`/api/runs/${runId}/`);
      return absorb(res.data);
    } catch {
      // A run deleted from under us, or a server that went away. Neither is
      // worth an error banner over a list that is still perfectly readable.
      return null;
    }
  }

  /** Polls one run until it reaches a terminal status. Idempotent per run. */
  function watchRun(runId: string) {
    if (pollTimers.has(runId)) return;

    const tick = async () => {
      pollTimers.delete(runId);
      const record = await refresh(runId);
      if (!record || isTerminal(record.status)) return;
      pollTimers.set(runId, setTimeout(tick, POLL_INTERVAL_MS));
    };

    pollTimers.set(runId, setTimeout(tick, POLL_INTERVAL_MS));
  }

  function unwatchRun(runId: string) {
    const timer = pollTimers.get(runId);
    if (timer !== undefined) clearTimeout(timer);
    pollTimers.delete(runId);
  }

  // -- logs ------------------------------------------------------------------

  /**
   * Streams one run's log.
   *
   * The server replays from the beginning of the event file, so the buffer is
   * cleared first: reconnecting to a stream that already delivered 400 lines
   * would otherwise show all of them twice.
   */
  function connectLogs(runId: string) {
    if (streams.has(runId)) return;
    logs.set(runId, []);

    // Same origin as the app, so no token in the query string: EventSource
    // cannot set headers, which is why the Django version needed one.
    const source = new EventSource(`/api/runs/${runId}/logs/`);
    streams.set(runId, source);
    streaming.add(runId);

    source.onmessage = (event) => {
      logs.get(runId)?.push(event.data);
    };

    source.addEventListener("stage", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data);
        stages.set(runId, { name: payload.stage, status: payload.status });
      } catch {
        // A stage line we cannot parse is not worth breaking the log over.
      }
    });

    source.addEventListener("done", () => {
      disconnectLogs(runId);
      // The stream ends before the outcome file is necessarily visible to the
      // next poll, so ask once more rather than waiting out a poll interval.
      void refresh(runId);
    });

    source.onerror = () => {
      disconnectLogs(runId);
    };
  }

  function disconnectLogs(runId: string) {
    streams.get(runId)?.close();
    streams.delete(runId);
    streaming.delete(runId);
  }

  function isStreaming(runId: string): boolean {
    return streaming.has(runId);
  }

  // -- history ---------------------------------------------------------------

  async function load(versionId: string): Promise<void> {
    isLoading.value = true;
    error.value = null;
    try {
      const res = await client.get<RunRecord[]>(`/api/versions/${versionId}/runs/`);
      records.clear();
      for (const record of res.data) absorb(record);
      // A run left behind by a previous session may still be solving; the
      // history list is where we find that out.
      for (const record of res.data) {
        if (!isTerminal(record.status)) watchRun(record.id);
      }
    } catch (caught) {
      error.value = (caught as Error).message ?? String(caught);
    } finally {
      isLoading.value = false;
    }
  }

  async function startRun(
    versionId: string,
    options: RunOptions = {},
  ): Promise<RunRecord> {
    const res = await client.post<RunRecord>(
      `/api/versions/${versionId}/runs/`,
      options,
    );
    const record = absorb(res.data);
    connectLogs(record.id);
    watchRun(record.id);
    return record;
  }

  async function cancel(runId: string): Promise<void> {
    const res = await client.post<RunRecord>(`/api/runs/${runId}/cancel/`);
    absorb({ ...res.data, results_handle: res.data.results_handle ?? null });
  }

  async function rename(runId: string, label: string): Promise<void> {
    const res = await client.patch<RunRecord>(`/api/runs/${runId}/`, { label });
    absorb(res.data);
  }

  /**
   * Deletes a run and everything it produced.
   *
   * Its tab goes too: leaving it open would leave a pane pointing at a results
   * file that no longer exists, and the user has just said they are done with it.
   */
  async function remove(runId: string): Promise<void> {
    await client.delete(`/api/runs/${runId}/`);
    unwatchRun(runId);
    disconnectLogs(runId);
    records.delete(runId);
    logs.delete(runId);
    stages.delete(runId);
    useTabsStore().closeRun(runId);
  }

  /** Stops every timer and stream. For a version switch, or a teardown. */
  function stopAll() {
    for (const runId of [...pollTimers.keys()]) unwatchRun(runId);
    for (const runId of [...streams.keys()]) disconnectLogs(runId);
  }

  return {
    records,
    logs,
    stages,
    ordered,
    active,
    totalBytes,
    isLoading,
    error,
    get,
    logsFor,
    isStreaming,
    load,
    refresh,
    watchRun,
    unwatchRun,
    connectLogs,
    disconnectLogs,
    startRun,
    cancel,
    rename,
    remove,
    stopAll,
  };
});
