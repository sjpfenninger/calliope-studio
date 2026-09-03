import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";

import { errorDetail } from "../api/errors";
import * as api from "../api/runs";
import { runLogsUrl } from "../api/runs";
import {
  getScenarioCatalog,
  getSettings,
  getSolvers,
  patchSettings,
} from "../api/versions";
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

// `RunStatus` and `RunRecord` moved to `api/runs.ts`, where the calls that
// return them live. Re-exported because much of the app imports them from here.
export type { RunRecord, RunStatus } from "../api/runs";
import type { RunRecord, RunStatus } from "../api/runs";

export interface RunOptions {
  label?: string | null;
  scenario?: string | null;
  override_dict?: Record<string, unknown>;
  build_only?: boolean;
}

/** One name `scenario=` accepts, and enough to say what it is. */
export interface ScenarioEntry {
  name: string;
  file: string;
  /** Scenarios: which overrides this one composes. */
  overrides?: string[];
  /** Scenarios: named overrides no file defines. Unrunnable as it stands. */
  missing?: string[];
  /** Overrides: how many settings this one makes. */
  setting_count?: number;
}

/**
 * What may be run, beside the model as written.
 *
 * Two lists rather than one because they are different things to choose
 * between, even though Calliope's `scenario=` takes either: a scenario is a
 * named composition, an override is one of the pieces.
 */
export interface ScenarioCatalog {
  scenarios: ScenarioEntry[];
  overrides: ScenarioEntry[];
}

const EMPTY_CATALOG: ScenarioCatalog = { scenarios: [], overrides: [] };

/**
 * The stages a run passes through, in order.
 *
 * Mirrors `STAGES` in src/calliope_studio/runs/protocol.py. These are Calliope's
 * own divisions rather than the worker's wrapper boundaries, which is why
 * `postprocess` is among them: only Calliope knows where it begins.
 *
 * Not every run visits every one — a resolution goes straight from `preprocess`
 * to `save` — so a stage the run never entered is skipped, not pending.
 */
export const RUN_STAGES = [
  "preprocess",
  "build",
  "solve",
  "postprocess",
  "save",
] as const;

export type RunStageName = (typeof RUN_STAGES)[number];

/** Which stage the run last announced, and what it is doing within it. */
export interface RunStage {
  name: string;
  status: string;
  /** What the stage is working on, when Calliope says: a component group, a
   * time window, a SPORE. Null when it has not said. */
  detail: string | null;
}

/** One line of a run's log. */
export interface LogLine {
  text: string;
  level: string;
  logger: string;
}

/** How much of the log to show. */
export type LogFilter = "all" | "info" | "errors";

/**
 * How many lines of a run's log are kept.
 *
 * The whole log is on disk and replayed on connect, so this bounds the browser
 * rather than the record. A solver logging every node of a long MILP would
 * otherwise put a hundred thousand reactive strings behind one `v-for`.
 */
export const MAX_LOG_LINES = 5000;

const LEVEL_RANK: Record<string, number> = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
  CRITICAL: 4,
};

/** The lowest level each filter shows. */
const FILTER_FLOOR: Record<LogFilter, number> = {
  all: 0,
  info: LEVEL_RANK.INFO,
  errors: LEVEL_RANK.ERROR,
};

export function passesFilter(line: LogLine, filter: LogFilter): boolean {
  // Solver output arrives at DEBUG, which is what makes "hide debug" the useful
  // middle setting: Calliope's own account of the run, without the iteration
  // log underneath it.
  return (LEVEL_RANK[line.level] ?? LEVEL_RANK.INFO) >= FILTER_FLOOR[filter];
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

/** The choices offered for how much history to keep. `null` keeps everything. */
export const RETENTION_CHOICES: Array<number | null> = [5, 10, 20, 50, 100, null];

export const useRunsStore = defineStore("runs", () => {
  const records = reactive(new Map<string, RunRecord>());
  const logs = reactive(new Map<string, LogLine[]>());
  /** How many lines were dropped from the front of each buffer, if any. */
  const trimmed = reactive(new Map<string, number>());
  const stages = reactive(new Map<string, RunStage>());
  const streaming = reactive(new Set<string>());
  const logFilter = ref<LogFilter>("all");
  const isLoading = ref(false);
  const error = ref<string | null>(null);
  /** How many runs this workspace keeps. Null means all of them. */
  const retention = ref<number | null>(null);
  /** What this model's files offer, for the Run sidebar's picker. */
  const scenarios = ref<ScenarioCatalog>(EMPTY_CATALOG);
  /** Which model the catalogue is for, so a re-entry is not a reset. */
  const scenarioVersionId = ref<string | null>(null);
  /** The one the next run applies. Null runs the model as written. */
  const scenario = ref<string | null>(null);
  /**
   * Solver names Pyomo can reach where this model's runs happen.
   *
   * Here rather than in the schema store, which answers what the installed
   * Calliope *allows* — a different question from what this machine can be
   * asked to do, and one whose answer is per model rather than global.
   */
  const solvers = ref<string[]>([]);
  /** Which model the list is for, so switching models re-asks. */
  const solverVersionId = ref<string | null>(null);

  // Not reactive: nothing renders a timer or an EventSource, and making them
  // reactive would mean Vue proxying objects the browser handed us.
  const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const streams = new Map<string, EventSource>();

  /** Which model `load` last asked about; what a late reply is checked against. */
  let loadedVersionId: string | null = null;

  /** Newest first, which is the only order a history list is ever read in. */
  const ordered = computed(() =>
    [...records.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)),
  );

  const active = computed(() => ordered.value.filter((run) => !isTerminal(run.status)));

  /** Whether this model defines anything to pick between. */
  const hasScenarios = computed(
    () => scenarios.value.scenarios.length + scenarios.value.overrides.length > 0,
  );

  const totalBytes = computed(() =>
    ordered.value.reduce((sum, run) => sum + run.size_bytes, 0),
  );

  function get(runId: string): RunRecord | undefined {
    return records.get(runId);
  }

  function logsFor(runId: string): LogLine[] {
    return logs.get(runId) ?? [];
  }

  function trimmedFor(runId: string): number {
    return trimmed.get(runId) ?? 0;
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
      return absorb(await api.getRun(runId));
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
    trimmed.set(runId, 0);

    // Same origin as the app, so no token in the query string: EventSource
    // cannot set headers, which is why the Django version needed one.
    const source = new EventSource(runLogsUrl(runId));
    streams.set(runId, source);
    streaming.add(runId);

    source.addEventListener("log", (event) => {
      try {
        appendLog(runId, JSON.parse((event as MessageEvent).data));
      } catch {
        // A line we cannot parse is not worth breaking the log over.
      }
    });

    source.addEventListener("stage", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data);
        // `payload.name`, not `payload.stage`: the worker has always sent
        // `name`, and reading the wrong key put the word "undefined" where the
        // stage should have been for as long as the display existed.
        stages.set(runId, {
          name: payload.name,
          status: payload.status,
          detail: payload.detail ?? null,
        });
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

  /**
   * Adds one log event, which may be many lines.
   *
   * Calliope logs a solver's output in chunks, so one record routinely carries
   * a whole screen of it. Splitting here is what lets the viewport scroll, the
   * filter apply and the cap count in lines rather than in arbitrary blocks.
   */
  function appendLog(runId: string, payload: Record<string, unknown>) {
    const buffer = logs.get(runId);
    if (!buffer) return;

    const level = String(payload.level ?? "INFO");
    const logger = String(payload.logger ?? "");
    for (const text of String(payload.msg ?? "").split("\n")) {
      buffer.push({ text, level, logger });
    }

    const excess = buffer.length - MAX_LOG_LINES;
    if (excess > 0) {
      buffer.splice(0, excess);
      trimmed.set(runId, trimmedFor(runId) + excess);
    }
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

  async function loadSettings(versionId: string): Promise<void> {
    try {
      retention.value = (await getSettings(versionId)).run_retention;
    } catch {
      // A viewer-mode server has no workspace to have settings; the control
      // simply does not appear.
    }
  }

  /**
   * Loads what the model offers to run, and drops a pick that has gone.
   *
   * The pick is cleared on a change of *model*, not on every load: `load` runs
   * each time the Runs section is entered, and a picker that forgot itself
   * whenever the user glanced at Model would be worse than no picker at all.
   *
   * It is also cleared when the name is no longer in the catalogue — an
   * override deleted from the file while it was selected. Leaving it would show
   * a name the server is about to reject with a 400 nothing in the sidebar
   * explains.
   */
  async function loadScenarios(versionId: string): Promise<void> {
    if (scenarioVersionId.value !== versionId) {
      scenario.value = null;
      scenarioVersionId.value = versionId;
    }
    try {
      const catalog = await getScenarioCatalog<Partial<ScenarioCatalog>>(versionId);
      scenarios.value = {
        scenarios: catalog?.scenarios ?? [],
        overrides: catalog?.overrides ?? [],
      };
    } catch {
      // A viewer-mode server has no workspace to have scenarios; the strip
      // simply does not appear.
      scenarios.value = EMPTY_CATALOG;
    }
    const known = new Set(
      [...scenarios.value.scenarios, ...scenarios.value.overrides].map(
        (entry) => entry.name,
      ),
    );
    if (scenario.value !== null && !known.has(scenario.value)) scenario.value = null;
  }

  /**
   * Fetches what this model's runs can be solved with.
   *
   * Failure leaves the field free text with no menu, which is the honest
   * degradation: the name is a suggestion either way, and a viewer-mode server
   * has no workspace to ask about.
   */
  async function loadSolvers(versionId: string): Promise<void> {
    if (solverVersionId.value === versionId) return;
    try {
      solvers.value = await getSolvers(versionId);
      solverVersionId.value = versionId;
    } catch {
      solvers.value = [];
    }
  }

  /**
   * Changes how much history this workspace keeps.
   *
   * Nothing is deleted here — the server prunes when a run *starts*. A settings
   * change that silently removed results as you moved the number would be a
   * trap, so lowering the limit only takes effect next time.
   */
  async function setRetention(versionId: string, keep: number | null): Promise<void> {
    const settings = await patchSettings(versionId, { run_retention: keep });
    retention.value = settings.run_retention;
  }

  /**
   * The history for one model, and the end of the previous model's.
   *
   * `stopAll` belongs here rather than in whichever section happens to be
   * watching: `RunsSection` unmounts every time the user looks at Model or
   * Files, so a model switch made from either fired its watcher `immediate`
   * with no previous value and stopped nothing — the old model's poll and
   * `EventSource` kept running and its run was absorbed into the new model's
   * list on the next tick.
   *
   * The awaited history is guarded the way `stores/schemaKinds.ts` guards its
   * reply, because `records.clear()` followed by an absorb of whichever list
   * lands last is how one model's runs end up under another's id.
   */
  async function load(versionId: string): Promise<void> {
    if (loadedVersionId !== null && loadedVersionId !== versionId) stopAll();
    loadedVersionId = versionId;
    isLoading.value = true;
    error.value = null;
    void loadSettings(versionId);
    void loadScenarios(versionId);
    try {
      const history = await api.listRuns(versionId);
      if (loadedVersionId !== versionId) return;
      records.clear();
      // The per-run buffers accumulated for every run ever listed this session,
      // so a long-lived window held the log of every run of every model it had
      // visited. Dropping what the new history does not name is the one moment
      // it is safe to: a run that is gone from it has no pane left to read it.
      forgetRunsOutside(new Set(history.map((record) => record.id)));
      for (const record of history) absorb(record);
      // A run left behind by a previous session may still be solving; the
      // history list is where we find that out.
      for (const record of history) {
        if (!isTerminal(record.status)) watchRun(record.id);
      }
    } catch (caught) {
      if (loadedVersionId !== versionId) return;
      error.value = errorDetail(caught, "Could not read the run history.");
    } finally {
      if (loadedVersionId === versionId) isLoading.value = false;
    }
  }

  /** Drops every per-run buffer for a run the given history does not carry. */
  function forgetRunsOutside(keep: Set<string>) {
    for (const runId of [...logs.keys()]) {
      if (keep.has(runId)) continue;
      logs.delete(runId);
      trimmed.delete(runId);
    }
    for (const runId of [...stages.keys()]) {
      if (!keep.has(runId)) stages.delete(runId);
    }
  }

  async function startRun(
    versionId: string,
    options: RunOptions = {},
  ): Promise<RunRecord> {
    const record = absorb(await api.startRun(versionId, options));
    connectLogs(record.id);
    watchRun(record.id);
    return record;
  }

  async function cancel(runId: string): Promise<void> {
    const record = await api.cancelRun(runId);
    absorb({ ...record, results_handle: record.results_handle ?? null });
  }

  async function rename(runId: string, label: string): Promise<void> {
    absorb(await api.renameRun(runId, label));
  }

  /**
   * Deletes a run and everything it produced.
   *
   * Its tab goes too: leaving it open would leave a pane pointing at a results
   * file that no longer exists, and the user has just said they are done with it.
   */
  async function remove(runId: string): Promise<void> {
    await api.deleteRun(runId);
    unwatchRun(runId);
    disconnectLogs(runId);
    records.delete(runId);
    logs.delete(runId);
    trimmed.delete(runId);
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
    logFilter,
    ordered,
    active,
    totalBytes,
    isLoading,
    error,
    retention,
    scenarios,
    scenario,
    hasScenarios,
    solvers,
    loadScenarios,
    loadSolvers,
    get,
    logsFor,
    trimmedFor,
    isStreaming,
    load,
    setRetention,
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
