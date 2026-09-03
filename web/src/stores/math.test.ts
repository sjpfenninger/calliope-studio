import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/system", () => ({ cancelTask: vi.fn() }));
vi.mock("../api/versions", () => ({
  getMathRender: vi.fn(),
  getMathSources: vi.fn(),
  startMathRender: vi.fn(),
}));

import { getMathSources, type MathSourcesPayload } from "../api/versions";
import { useMathStore } from "./math";

const fetchSources = vi.mocked(getMathSources);

function payload(fingerprint: string, name = "base"): MathSourcesPayload {
  return {
    sources: [{ name, kind: "builtin", applied: true }],
    components: {},
    fingerprint,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
});
