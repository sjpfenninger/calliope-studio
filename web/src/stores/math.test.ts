import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/system", () => ({ cancelTask: vi.fn() }));
vi.mock("../api/versions", () => ({
  getMathRender: vi.fn(),
  getMathSources: vi.fn(),
  startMathRender: vi.fn(),
}));

import { cancelTask } from "../api/system";
import {
  getMathRender,
  getMathSources,
  startMathRender,
  type MathEnvelope,
  type MathPayload,
  type MathSourcesPayload,
} from "../api/versions";
import { useMathStore } from "./math";

const fetchSources = vi.mocked(getMathSources);
const start = vi.mocked(startMathRender);
const poll = vi.mocked(getMathRender);
const cancel = vi.mocked(cancelTask);

function payload(fingerprint: string, name = "base"): MathSourcesPayload {
  return {
    sources: [{ name, kind: "builtin", applied: true }],
    components: {},
    fingerprint,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function rendering(name = "flow_cap"): MathPayload {
  return {
    mode: "base",
    priority: [{ name: "base", kind: "builtin" }],
    objective: "min_cost_optimisation",
    groups: [
      {
        key: "constraints",
        label: "Constraints",
        components: [
          {
            name,
            group: "constraints",
            title: name,
            description: "",
            unit: "",
            latex: "x \\leq y",
            uses: [],
            used_in: [],
            sources: ["base"],
            origin: "base",
            overridden: false,
          },
        ],
      },
    ],
  };
}

function envelope(over: Partial<MathEnvelope> = {}): MathEnvelope {
  return { task_id: "t1", status: "running", phase: "math", result: null, ...over };
}

/**
 * The cheap half of the math store, and the guard it was missing.
 *
 * `render` and `poll` both check `generation`; `loadSources` beside them did
 * not, although `reset()` bumps it for exactly this. What made that worse than
 * a stale list of filenames is the *fingerprint* the payload carries: assigned
 * from a superseded reply it becomes one model's fingerprint compared against
 * another model's rendering, so `isStale` reported the notation on screen as
 * out of date and no amount of re-rendering could make it agree.
 */
describe("useMathStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fetchSources.mockReset();
    start.mockReset();
    poll.mockReset();
    cancel.mockReset();
    cancel.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores a sources reply that a reset has already superseded", async () => {
    const store = useMathStore();
    const pending = deferred<MathSourcesPayload>();
    fetchSources.mockReturnValue(pending.promise);

    const inFlight = store.loadSources("v1");
    store.reset();
    pending.resolve(payload("fp-v1", "user_math"));
    await inFlight;

    expect(store.sources).toEqual([]);
    expect(store.isLoadingSources).toBe(false);
  });

  it("ignores a failure that a reset has already superseded", async () => {
    // Otherwise the new model's Math group opens carrying the error raised
    // about a model the user is no longer looking at.
    const store = useMathStore();
    fetchSources.mockRejectedValue(new Error("connection refused"));

    const inFlight = store.loadSources("v1");
    store.reset();
    await inFlight;

    expect(store.sourcesError).toBeNull();
  });

  it("lets the newest model win when two loads overlap", async () => {
    // A reset is not the only way to get two in flight: the Model tree asks on
    // every entry to the section, so a switch made quickly enough overlaps them
    // with nothing bumping the generation in between.
    const store = useMathStore();
    const a = deferred<MathSourcesPayload>();
    const b = deferred<MathSourcesPayload>();
    fetchSources.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

    const first = store.loadSources("A");
    const second = store.loadSources("B");
    b.resolve(payload("fp-b", "b_math"));
    await second;
    a.resolve(payload("fp-a", "a_math"));
    await first;

    expect(store.sources.map((source) => source.name)).toEqual(["b_math"]);
    expect(store.isLoadingSources).toBe(false);
  });

  it("reads what the files declare, fingerprint included", async () => {
    const store = useMathStore();
    fetchSources.mockResolvedValue({
      sources: [
        { name: "base", kind: "builtin", applied: true },
        { name: "storage_inter_cluster", kind: "user", applied: false },
      ],
      components: {},
      fingerprint: "fp",
    });

    await store.loadSources("v1");

    // A file declared in `math_paths` and never named in `extra_math` is read
    // by nobody, and Calliope warns about nothing because nobody asked it to.
    expect(store.unappliedSources.map((source) => source.name)).toEqual([
      "storage_inter_cluster",
    ]);
  });

  it("has nothing to be stale against before anything is rendered", async () => {
    const store = useMathStore();
    fetchSources.mockResolvedValue(payload("fp-new"));

    await store.loadSources("v1");

    expect(store.isStale).toBe(false);
  });

  describe("rendering", () => {
    /**
     * The expensive half: a subprocess, polled, cancellable, and the half where
     * `stores/compare.ts` had every one of its bugs — a superseded reply
     * overwriting a newer one, a phase that never left `rendering`, and a
     * cancel that left the poll chain running.
     */

    it("takes an answer that needs no polling", async () => {
      // The server hands back a rendering it already had, from memory or from
      // the on-disk cache, with no task to follow. Answered here or the tab
      // would poll a task id that is null.
      const store = useMathStore();
      start.mockResolvedValue(
        envelope({ task_id: null, status: "done", result: rendering(), fingerprint: "fp" }),
      );

      await store.render("v1");

      expect(store.phase).toBe("done");
      expect(store.componentCount).toBe(1);
      expect(poll).not.toHaveBeenCalled();
      // Both fingerprints come from the envelope, so the answer it just took
      // is not immediately reported as out of date.
      expect(store.isStale).toBe(false);

      // And it does become stale once the files move under it, which is the
      // whole point of carrying a fingerprint on both payloads.
      fetchSources.mockResolvedValue(payload("fp-moved"));
      await store.loadSources("v1");
      expect(store.isStale).toBe(true);
    });

    it("polls until the task is done", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const store = useMathStore();
      start.mockResolvedValue(envelope());
      poll
        .mockResolvedValueOnce(envelope())
        .mockResolvedValueOnce(envelope({ status: "done", result: rendering() }));

      void store.render("v1");
      await vi.advanceTimersByTimeAsync(0);
      expect(store.isRendering).toBe(true);
      expect(store.taskId).toBe("t1");

      await vi.advanceTimersByTimeAsync(5000);

      expect(store.phase).toBe("done");
      expect(store.componentCount).toBe(1);
      expect(store.taskId).toBeNull();
    });

    it("shows Calliope's own complaint when a render finishes with nothing", async () => {
      // A model whose math does not parse fails inside the LaTeX backend, and
      // that message is the most useful thing on the screen for somebody who
      // has just written it. Swallowing it would leave an empty pane.
      const store = useMathStore();
      start.mockResolvedValue(
        envelope({ task_id: null, status: "done", error: "expression is not valid" }),
      );

      await store.render("v1");

      expect(store.phase).toBe("done");
      expect(store.renderError).toBe("expression is not valid");
      expect(store.payload).toBeNull();
    });

    it("reports a failure to start, and does not stay rendering", async () => {
      const store = useMathStore();
      start.mockRejectedValue(new Error("no worker"));

      await store.render("v1");

      expect(store.renderError).toBe("no worker");
      expect(store.phase).toBe("idle");
      expect(store.isRendering).toBe(false);
    });

    it("reports a failure while polling", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const store = useMathStore();
      start.mockResolvedValue(envelope());
      poll.mockRejectedValue(new Error("gone"));

      void store.render("v1");
      await vi.advanceTimersByTimeAsync(1000);

      expect(store.renderError).toBe("gone");
      expect(store.phase).toBe("idle");
    });

    it("refuses to start a second render over one in flight", async () => {
      const store = useMathStore();
      const pending = deferred<MathEnvelope>();
      start.mockReturnValue(pending.promise);

      const first = store.render("v1");
      await store.render("v1");
      expect(start).toHaveBeenCalledTimes(1);

      pending.resolve(envelope({ task_id: null, status: "done", result: rendering() }));
      await first;
    });

    it("discards a start that a reset has superseded", async () => {
      const store = useMathStore();
      const pending = deferred<MathEnvelope>();
      start.mockReturnValue(pending.promise);

      const inFlight = store.render("v1");
      store.reset();
      pending.resolve(envelope({ task_id: null, status: "done", result: rendering() }));
      await inFlight;

      expect(store.payload).toBeNull();
      expect(store.phase).toBe("idle");
    });

    it("discards a poll that a cancel has superseded", async () => {
      // The generation is bumped before the request is sent, so a reply already
      // on the wire cannot report the killed task as a finished one.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const store = useMathStore();
      start.mockResolvedValue(envelope());
      const pending = deferred<MathEnvelope>();
      poll.mockReturnValue(pending.promise);

      void store.render("v1");
      await vi.advanceTimersByTimeAsync(300);
      await store.cancel();
      pending.resolve(envelope({ status: "done", result: rendering() }));
      await vi.advanceTimersByTimeAsync(0);

      expect(store.payload).toBeNull();
      expect(store.phase).toBe("idle");
    });

    it("cancels the task and stops asking", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const store = useMathStore();
      start.mockResolvedValue(envelope());
      poll.mockResolvedValue(envelope());

      void store.render("v1");
      await vi.advanceTimersByTimeAsync(1000);
      const asked = poll.mock.calls.length;

      await store.cancel();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(cancel).toHaveBeenCalledWith("t1");
      expect(poll.mock.calls.length).toBe(asked);
      expect(store.taskId).toBeNull();
      expect(store.isRendering).toBe(false);
    });

    it("keeps the previous rendering when a re-render is cancelled", async () => {
      // A cancelled render has no answer of its own, and throwing the last one
      // away would punish the user for changing their mind.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const store = useMathStore();
      start.mockResolvedValueOnce(
        envelope({ task_id: null, status: "done", result: rendering("first") }),
      );
      await store.render("v1");
      expect(store.componentCount).toBe(1);

      start.mockResolvedValueOnce(envelope());
      poll.mockResolvedValue(envelope());
      void store.render("v1");
      await vi.advanceTimersByTimeAsync(300);
      await store.cancel();

      expect(store.phase).toBe("done");
      expect(store.componentCount).toBe(1);
    });

    it("survives a cancel with nothing to cancel", async () => {
      const store = useMathStore();
      await store.cancel();
      expect(cancel).not.toHaveBeenCalled();
      expect(store.phase).toBe("idle");
    });

    it("treats a refused cancel as the state it wanted anyway", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const store = useMathStore();
      start.mockResolvedValue(envelope());
      poll.mockResolvedValue(envelope());
      cancel.mockRejectedValue(new Error("already gone"));

      void store.render("v1");
      await vi.advanceTimersByTimeAsync(300);
      await store.cancel();

      expect(store.taskId).toBeNull();
      expect(store.isRendering).toBe(false);
    });

    it("drops a selection the new rendering no longer has", async () => {
      const store = useMathStore();
      start.mockResolvedValueOnce(
        envelope({ task_id: null, status: "done", result: rendering("gone_next_time") }),
      );
      await store.render("v1");
      store.select("constraints:gone_next_time");

      start.mockResolvedValueOnce(
        envelope({ task_id: null, status: "done", result: rendering("something_else") }),
      );
      await store.render("v1");

      expect(store.selectedKey).toBeNull();
    });
  });
});
