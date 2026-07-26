import { ref } from "vue";
import { defineStore } from "pinia";
import client from "../api/client";

/** Matches `TERMINAL_STATUSES` in src/calligraph/runs/manager.py. */
export type RunStatus =
  | "pending"
  | "running"
  | "success"
  | "infeasible"
  | "failed"
  | "cancelled";

export interface Run {
  id: string;
  status: RunStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  results_handle?: string | null;
  label?: string | null;
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

export const useRunStore = defineStore("run", () => {
  const activeRun = ref<Run | null>(null);
  const logs = ref<string[]>([]);
  const isStreaming = ref(false);

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let eventSource: EventSource | null = null;

  function _stopPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function _stopStreaming() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    isStreaming.value = false;
  }

  function _pollStatus(runId: string) {
    pollTimer = setTimeout(async () => {
      const res = await client.get<Run>(`/api/runs/${runId}/`);
      activeRun.value = res.data;
      if (!TERMINAL_STATUSES.has(res.data.status)) {
        _pollStatus(runId);
      }
    }, 2000);
  }

  function connectLogs(runId: string) {
    _stopStreaming();
    logs.value = [];
    isStreaming.value = true;

    // Same origin as the app, so no token in the query string: EventSource
    // cannot set headers, which is why the Django version needed one.
    eventSource = new EventSource(`/api/runs/${runId}/logs/`);

    eventSource.onmessage = (e) => {
      logs.value.push(e.data);
    };

    eventSource.addEventListener("done", () => {
      _stopStreaming();
    });

    eventSource.onerror = () => {
      _stopStreaming();
    };
  }

  async function startRun(versionId: string): Promise<void> {
    _stopPolling();
    _stopStreaming();
    logs.value = [];

    const res = await client.post<Run>(`/api/versions/${versionId}/runs/`);
    activeRun.value = res.data;

    connectLogs(res.data.id);
    _pollStatus(res.data.id);
  }

  return { activeRun, logs, isStreaming, startRun, connectLogs };
});
