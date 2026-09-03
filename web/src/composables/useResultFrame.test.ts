import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";

vi.mock("../api/results", () => ({ streamFrame: vi.fn() }));

import { streamFrame, type ResultFrame, type ResultQuery } from "../api/results";
import { useResultFrame } from "./useResultFrame";

const stream = vi.mocked(streamFrame);

function frame(variable: string, values: number[]): ResultFrame {
  return {
    index: values.map((_, i) => i),
    indexName: "timesteps",
    indexIsTime: false,
    series: [{ key: variable, values: Float64Array.from(values), dims: {} }],
    variable,
    order: "time",
    seriesDims: [],
    unit: null,
  };
}

/**
 * A generator that yields only what the test tells it to, when it says so.
 *
 * A real stream cannot be paused mid-flight, and every bug here is about what
 * happens *between* two batches: the query changing, the request being aborted,
 * a superseded generator carrying on.
 */
function controllable() {
  const queue: ResultFrame[] = [];
  let wake: (() => void) | null = null;
  let done = false;

  async function* generator(): AsyncGenerator<ResultFrame> {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    generator,
    async emit(next: ResultFrame) {
      queue.push(next);
      wake?.();
      wake = null;
      await nextTick();
      await Promise.resolve();
    },
    async end() {
      done = true;
      wake?.();
      wake = null;
      await nextTick();
      await Promise.resolve();
    },
  };
}

/**
 * A stream that produces no batches and then fails.
 *
 * It has to be a generator rather than a rejecting `async` function, because
 * `useResultFrame` puts the return value straight into `for await`: an ordinary
 * promise fails there as a `TypeError` about the iterator protocol, which is
 * not the failure under test. `yield*` over nothing is what makes it one.
 */
function failing(error: Error) {
  return async function* (): AsyncGenerator<ResultFrame> {
    yield* [];
    throw error;
  };
}

/**
 * Lets the microtask queue drain.
 *
 * `load` is not awaited by the watcher that starts it, so every assertion here
 * is about state settled some number of ticks later — and how many depends on
 * how deep into the async generator protocol the value came from, which is not
 * something a test should be asserting about.
 */
async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await nextTick();
    await Promise.resolve();
  }
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/** Runs `body` inside an effect scope, so `onScopeDispose` has one to attach to. */
async function inScope(body: () => Promise<void> | void) {
  const scope = effectScope();
  try {
    await scope.run(body)!;
  } finally {
    scope.stop();
  }
}

const QUERY: ResultQuery = { variable: "flow_cap" };

describe("useResultFrame", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    stream.mockReset();
  });

  it("stops loading when the query goes null mid-stream", async () => {
    /**
     * The spinner that never stopped. `cancelInFlight` nulls `controller`
     * before the null-query branch returns, so the aborted request's `finally`
     * no longer recognises itself as the current one and never clears
     * `loading` — and nothing else was ever going to. Reachable by setting a
     * map colour variable and then picking a pie variable before the first
     * frame lands, which makes the colour query null.
     */
    const source = controllable();
    stream.mockImplementation(source.generator);

    await inScope(async () => {
      const handle = ref<string | null>("h1");
      const query = ref<ResultQuery | null>(QUERY);
      const result = useResultFrame(handle, query);
      await nextTick();
      expect(result.loading.value).toBe(true);

      query.value = null;
      await flush();

      expect(result.loading.value).toBe(false);
      expect(result.raw.value).toBeNull();
    });
  });

  it("clears a previous error when the query goes null", async () => {
    // A figure switched off must not keep showing the complaint from the last
    // thing it was asked for.
    stream.mockImplementation(failing(new Error("Result query failed (500): boom")));

    await inScope(async () => {
      const handle = ref<string | null>("h1");
      const query = ref<ResultQuery | null>(QUERY);
      const result = useResultFrame(handle, query);
      await flush();
      expect(result.error.value).toBe("Result query failed (500): boom");

      query.value = null;
      await flush();

      expect(result.error.value).toBeNull();
      expect(result.loading.value).toBe(false);
    });
  });

  it("does not let a superseded request overwrite the current frame", async () => {
    const first = controllable();
    const second = controllable();
    stream
      .mockImplementationOnce(first.generator)
      .mockImplementationOnce(second.generator);

    await inScope(async () => {
      const handle = ref<string | null>("h1");
      const query = ref<ResultQuery | null>(QUERY);
      const result = useResultFrame(handle, query);
      await nextTick();

      query.value = { variable: "flow_out" };
      await nextTick();
      await second.emit(frame("flow_out", [2]));

      // The old generator is still alive and still has data. It is aborted, so
      // its batches have to be dropped rather than merged into the new query's.
      await first.emit(frame("flow_cap", [1]));

      expect(result.raw.value?.variable).toBe("flow_out");
    });
  });

  it("treats an abort as no error at all", async () => {
    // Aborting is what this composable does on every filter change, so surfacing
    // it would put "AbortError" under a chart on every interaction.
    stream.mockImplementation(failing(abortError()));

    await inScope(async () => {
      const handle = ref<string | null>("h1");
      const query = ref<ResultQuery | null>(QUERY);
      const result = useResultFrame(handle, query);
      await flush();

      expect(result.error.value).toBeNull();
    });
  });

  it("aborts the request in flight when the query changes", async () => {
    const source = controllable();
    const signals: Array<AbortSignal | undefined> = [];
    stream.mockImplementation((_handle, _query, signal) => {
      signals.push(signal);
      return source.generator();
    });

    await inScope(async () => {
      const handle = ref<string | null>("h1");
      const query = ref<ResultQuery | null>(QUERY);
      useResultFrame(handle, query);
      await nextTick();

      query.value = { variable: "flow_out" };
      await nextTick();

      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
    });
  });

  it("paints each batch as it lands, rather than waiting for the last", async () => {
    const source = controllable();
    stream.mockImplementation(source.generator);

    await inScope(async () => {
      const handle = ref<string | null>("h1");
      const query = ref<ResultQuery | null>(QUERY);
      const result = useResultFrame(handle, query);
      await nextTick();

      await source.emit(frame("flow_cap", [1]));
      expect(result.raw.value?.series[0].values).toEqual(Float64Array.from([1]));

      await source.emit(frame("flow_cap", [1, 2]));
      expect(result.raw.value?.series[0].values).toEqual(Float64Array.from([1, 2]));

      await source.end();
      expect(result.loading.value).toBe(false);
    });
  });

  it("asks for nothing at all without a handle", async () => {
    await inScope(async () => {
      const handle = ref<string | null>(null);
      const query = ref<ResultQuery | null>(QUERY);
      const result = useResultFrame(handle, query);
      await nextTick();

      expect(stream).not.toHaveBeenCalled();
      expect(result.loading.value).toBe(false);
    });
  });
});
