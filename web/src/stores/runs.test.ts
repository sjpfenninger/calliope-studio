import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import client from "../api/client";
import { runTabId } from "../lib/tabId";
import {
  MAX_LOG_LINES,
  passesFilter,
  useRunsStore,
  type LogFilter,
  type RunRecord,
} from "./runs";
import { useTabsStore } from "./tabs";

vi.mock("../api/client", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const api = vi.mocked(client, true);

/** A stand-in for the browser's, capturing every stream that gets opened. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, handler]);
  }

  close() {
    this.closed = true;
  }

  /** One log event, as the server sends them: JSON, on a named event. */
  emitLog(msg: string, level = "INFO", logger = "calliope.model") {
    this.emitEvent("log", JSON.stringify({ t: "log", level, logger, msg }));
  }

  emitEvent(type: string, data: string) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ data } as MessageEvent);
    }
  }
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    status: "running",
    created_at: "2026-07-26T10:00:00Z",
    label: null,
    workspace: "/models/national",
    scenario: null,
    override_dict: {},
    build_only: false,
    started_at: null,
    completed_at: null,
    duration_seconds: null,
    termination_condition: null,
    solver: null,
    objective: null,
    timings: {},
    error: null,
    traceback: null,
    has_results: false,
    has_snapshot: true,
    snapshot_complete: true,
    solved_from: "snapshot",
    size_bytes: 1024,
    results_handle: null,
    ...overrides,
  };
}

/**
 * The runs store, which is what makes several runs open at once possible.
 *
 * The store it replaces held one `activeRun`, one log buffer and one poll timer.
 * Everything here is about that being per run instead: two runs streaming at
 * once must not share a buffer, and a poll must stop at *its own* run's terminal
 * status rather than at whichever run finished first.
 */
describe("useRunsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
    api.get.mockReset();
    api.post.mockReset();
    api.patch.mockReset();
    api.delete.mockReset();
  });

  /**
   * Answers the settings call and routes everything else to `data`.
   *
   * `load` fetches the workspace's retention setting as well as the history, so
   * a bare `mockResolvedValue` would hand the run list to both.
   */
  function serve(data: unknown) {
    api.get.mockImplementation((url: string) =>
      url.includes("/settings/")
        ? Promise.resolve({ data: { run_retention: 20 } })
        : Promise.resolve({ data }),
    );
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("history", () => {
    it("orders newest first, whatever the server sent", () => {
      // Run directories are UUIDs, so any order that looks deliberate is not.
      const runs = useRunsStore();
      serve([
        record({ id: "a", created_at: "2026-07-01T00:00:00Z" }),
        record({ id: "c", created_at: "2026-07-03T00:00:00Z" }),
        record({ id: "b", created_at: "2026-07-02T00:00:00Z" }),
      ]);

      return runs.load("v1").then(() => {
        expect(runs.ordered.map((run) => run.id)).toEqual(["c", "b", "a"]);
      });
    });

    it("adds up what the history costs on disk", async () => {
      const runs = useRunsStore();
      serve([
        record({ id: "a", size_bytes: 1000 }),
        record({ id: "b", size_bytes: 2500 }),
      ]);

      await runs.load("v1");
      expect(runs.totalBytes).toBe(3500);
    });

    it("resumes watching a run left solving by a previous session", async () => {
      const runs = useRunsStore();
      serve([record({ id: "a", status: "running" })]);
      await runs.load("v1");

      api.get.mockResolvedValue({ data: record({ id: "a", status: "success" }) });
      await vi.advanceTimersByTimeAsync(2000);

      expect(runs.get("a")?.status).toBe("success");
    });

    it("survives a listing that fails, rather than throwing into the view", async () => {
      const runs = useRunsStore();
      api.get.mockRejectedValue(new Error("connection refused"));

      await runs.load("v1");
      expect(runs.error).toBe("connection refused");
      expect(runs.isLoading).toBe(false);
    });
  });

  describe("retention", () => {
    it("comes back with the history", async () => {
      const runs = useRunsStore();
      serve([]);
      await runs.load("v1");
      expect(runs.retention).toBe(20);
    });

    it("can be set to keep everything", async () => {
      const runs = useRunsStore();
      api.patch.mockResolvedValue({ data: { run_retention: null } });

      await runs.setRetention("v1", null);
      expect(api.patch).toHaveBeenCalledWith("/api/versions/v1/settings/", {
        run_retention: null,
      });
      expect(runs.retention).toBeNull();
    });

    it("does not remove anything locally", async () => {
      // The server prunes when a run *starts*. A settings change that deleted
      // results as the number moved would be a trap.
      const runs = useRunsStore();
      serve([record({ id: "a" }), record({ id: "b" })]);
      await runs.load("v1");

      api.patch.mockResolvedValue({ data: { run_retention: 1 } });
      await runs.setRetention("v1", 1);

      expect(runs.ordered.length).toBe(2);
    });
  });

  describe("polling", () => {
    it("stops at a terminal status", async () => {
      const runs = useRunsStore();
      api.get.mockResolvedValue({ data: record({ id: "a", status: "infeasible" }) });
      runs.watchRun("a");

      await vi.advanceTimersByTimeAsync(2000);
      const settled = api.get.mock.calls.length;

      // `infeasible` and `cancelled` were missing from the terminal set, so a
      // model found infeasible was polled every two seconds for ever.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.get.mock.calls.length).toBe(settled);
    });

    it("polls two runs independently", async () => {
      const runs = useRunsStore();
      api.get.mockImplementation((url: string) =>
        Promise.resolve({
          data: url.includes("/a/")
            ? record({ id: "a", status: "success" })
            : record({ id: "b", status: "running" }),
        }),
      );

      runs.watchRun("a");
      runs.watchRun("b");
      await vi.advanceTimersByTimeAsync(2000);

      expect(runs.get("a")?.status).toBe("success");
      expect(runs.get("b")?.status).toBe("running");

      const afterFirst = api.get.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      // Only `b` is still being asked about; `a` finished.
      expect(api.get.mock.calls.length).toBe(afterFirst + 1);
    });

    it("does not start a second timer for the same run", async () => {
      const runs = useRunsStore();
      api.get.mockResolvedValue({ data: record({ id: "a", status: "running" }) });

      runs.watchRun("a");
      runs.watchRun("a");
      await vi.advanceTimersByTimeAsync(2000);

      expect(api.get.mock.calls.length).toBe(1);
    });
  });

  describe("logs", () => {
    it("keeps one buffer per run", () => {
      const runs = useRunsStore();
      runs.connectLogs("a");
      runs.connectLogs("b");

      FakeEventSource.instances[0].emitLog("solving a");
      FakeEventSource.instances[1].emitLog("solving b");

      expect(runs.logsFor("a").map((line) => line.text)).toEqual(["solving a"]);
      expect(runs.logsFor("b").map((line) => line.text)).toEqual(["solving b"]);
    });

    it("does not open a second stream for a run already streaming", () => {
      const runs = useRunsStore();
      runs.connectLogs("a");
      runs.connectLogs("a");
      expect(FakeEventSource.instances.length).toBe(1);
    });

    it("keeps the level and the logger a line arrived with", () => {
      const runs = useRunsStore();
      runs.connectLogs("a");
      FakeEventSource.instances[0].emitLog("Presolve removed 4120 rows", "DEBUG", "x");

      expect(runs.logsFor("a")[0]).toEqual({
        text: "Presolve removed 4120 rows",
        level: "DEBUG",
        logger: "x",
      });
    });

    it("splits a multi-line record into lines", () => {
      /**
       * Calliope logs a solver's output in chunks, so one record carries a whole
       * screen of it. Kept whole it would be one unfilterable paragraph, and the
       * retention cap would count blocks rather than lines.
       */
      const runs = useRunsStore();
      runs.connectLogs("a");
      FakeEventSource.instances[0].emitLog("Welcome to CBC\nVersion: 2.10.13", "DEBUG");

      expect(runs.logsFor("a").map((line) => line.text)).toEqual([
        "Welcome to CBC",
        "Version: 2.10.13",
      ]);
    });

    it("keeps the most recent lines and counts what it dropped", () => {
      const runs = useRunsStore();
      runs.connectLogs("a");
      const source = FakeEventSource.instances[0];
      for (let i = 0; i < MAX_LOG_LINES + 20; i += 1) source.emitLog(`line ${i}`);

      const lines = runs.logsFor("a");
      expect(lines.length).toBe(MAX_LOG_LINES);
      expect(lines[lines.length - 1].text).toBe(`line ${MAX_LOG_LINES + 19}`);
      expect(runs.trimmedFor("a")).toBe(20);
    });

    it("records the stage the worker announces, and what it is doing", () => {
      const runs = useRunsStore();
      runs.connectLogs("a");
      FakeEventSource.instances[0].emitEvent(
        "stage",
        // `name`, which is the key the worker has always sent. Reading `stage`
        // put the word "undefined" in the header for as long as it existed, and
        // this test asserted the wrong key, so nothing caught it.
        JSON.stringify({
          t: "stage",
          name: "build",
          status: "start",
          detail: "constraints",
        }),
      );

      expect(runs.stages.get("a")).toEqual({
        name: "build",
        status: "start",
        detail: "constraints",
      });
    });

    it("filters by level without discarding anything", () => {
      const runs = useRunsStore();
      runs.connectLogs("a");
      const source = FakeEventSource.instances[0];
      source.emitLog("iteration 400", "DEBUG");
      source.emitLog("backend build complete", "INFO");
      source.emitLog("could not find a solution", "ERROR");

      const shown = (filter: LogFilter) =>
        runs.logsFor("a").filter((line) => passesFilter(line, filter)).length;
      expect(shown("all")).toBe(3);
      expect(shown("info")).toBe(2);
      expect(shown("errors")).toBe(1);
    });

    it("closes the stream and asks once more when the run is done", async () => {
      const runs = useRunsStore();
      api.get.mockResolvedValue({ data: record({ id: "a", status: "success" }) });
      runs.connectLogs("a");

      FakeEventSource.instances[0].emitEvent("done", "{}");
      await vi.advanceTimersByTimeAsync(0);

      // The stream ends before the outcome file is necessarily visible to the
      // next poll, so waiting one out would leave the tab on "running".
      expect(FakeEventSource.instances[0].closed).toBe(true);
      expect(runs.isStreaming("a")).toBe(false);
      expect(runs.get("a")?.status).toBe("success");
    });
  });

  describe("handing state to the tab", () => {
    it("gives an open run tab the handle its results arrived under", async () => {
      const tabs = useTabsStore();
      const runs = useRunsStore();
      tabs.openRun({ id: "a" });
      expect(tabs.get(runTabId("a"))).toMatchObject({ handle: null, subView: "log" });

      api.get.mockResolvedValue({
        data: record({ id: "a", status: "success", results_handle: "h1" }),
      });
      await runs.refresh("a");

      // The tab was opened the instant the run started; without this it would
      // show the log for ever with no route to the charts.
      expect(tabs.get(runTabId("a"))).toMatchObject({
        handle: "h1",
        subView: "results",
      });
    });

    it("closes the tab of a run that has been deleted", async () => {
      const tabs = useTabsStore();
      const runs = useRunsStore();
      api.get.mockResolvedValue({ data: record({ id: "a", status: "success" }) });
      await runs.refresh("a");
      tabs.openRun({ id: "a" });

      api.delete.mockResolvedValue({ data: null });
      await runs.remove("a");

      // A pane pointing at a results file that no longer exists is worse than no
      // pane at all.
      expect(tabs.has(runTabId("a"))).toBe(false);
      expect(runs.get("a")).toBeUndefined();
    });
  });

  describe("starting", () => {
    it("streams the log and polls, from the moment it starts", async () => {
      const runs = useRunsStore();
      api.post.mockResolvedValue({ data: record({ id: "a", status: "running" }) });

      await runs.startRun("v1", { label: "with storage" });

      expect(api.post).toHaveBeenCalledWith("/api/versions/v1/runs/", {
        label: "with storage",
      });
      expect(FakeEventSource.instances[0].url).toBe("/api/runs/a/logs/");
      expect(runs.active.map((run) => run.id)).toEqual(["a"]);
    });
  });

  describe("stopAll", () => {
    it("drops every timer and stream, for a switch to another model", async () => {
      const runs = useRunsStore();
      api.get.mockResolvedValue({ data: record({ id: "a", status: "running" }) });
      runs.watchRun("a");
      runs.connectLogs("a");

      runs.stopAll();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(FakeEventSource.instances[0].closed).toBe(true);
      expect(api.get).not.toHaveBeenCalled();
    });
  });
});
