import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/compare", () => ({
  getCompareFiles: vi.fn(),
  getCompareFile: vi.fn(),
  getCompareModel: vi.fn(),
}));

import * as api from "@/api/compare";
import { workspaceRef } from "@/lib/compareRef";
import { useCompareStore } from "./compare";

/**
 * The comparison cache: what it keeps, what it throws away, and when it stops
 * asking. The view is `v-if`, so everything a returning user sees is this.
 */
const A = workspaceRef(null);
const B = workspaceRef("high_cost");

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const side = { kind: "workspace", model: { source: "resolved" }, scenario_known: true } as never;
const files = (n: number) => ({ a: side, b: side, files: [], identical: true, same_root: false, n }) as never;
const model = (pending: boolean) => ({ a: side, b: side, available: !pending, pending }) as never;

const filesApi = api.getCompareFiles as ReturnType<typeof vi.fn>;
const modelApi = api.getCompareModel as ReturnType<typeof vi.fn>;

beforeEach(() => {
  setActivePinia(createPinia());
  filesApi.mockReset();
  modelApi.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useCompareStore", () => {
  it("keeps the files and the model on separate generations", async () => {
    // Sharing one counter made the model's claim supersede the files': the
    // file list threw its own answer away and the comparison showed nothing.
    const store = useCompareStore();
    const f = deferred<unknown>();
    const m = deferred<unknown>();
    filesApi.mockReturnValue(f.promise);
    modelApi.mockReturnValue(m.promise);

    const loading = Promise.all([store.loadFiles("v", A, B), store.loadModel("v", A, B)]);
    m.resolve(model(false));
    f.resolve(files(1));
    await loading;

    const state = store.stateOf(A, B);
    expect(state.files).not.toBeNull();
    expect(state.model).not.toBeNull();
  });

  it("discards a response the pair has moved past", async () => {
    const store = useCompareStore();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    filesApi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const one = store.loadFiles("v", A, B);
    const two = store.loadFiles("v", A, B);
    second.resolve(files(2));
    await two;
    first.resolve(files(1));
    await one;

    expect((store.stateOf(A, B).files as { n: number } | null)?.n).toBe(2);
    expect(store.stateOf(A, B).loadingFiles).toBe(false);
  });

  it("clears an error on the next attempt", async () => {
    const store = useCompareStore();
    modelApi.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(model(false));
    await store.loadModel("v", A, B);
    expect(store.stateOf(A, B).modelError).toBe("boom");
    await store.loadModel("v", A, B);
    expect(store.stateOf(A, B).modelError).toBeNull();
  });

  it("follows a pending side, and says so once it gives up", async () => {
    // The payload goes on saying `pending` after the polls run out; without
    // its own flag the view read that alone and loaded for ever.
    vi.useFakeTimers();
    const store = useCompareStore();
    modelApi.mockResolvedValue(model(true));

    await store.loadModel("v", A, B);
    expect(store.stateOf(A, B).resolving).toBe(true);
    expect(store.isResolving(A, B)).toBe(true);

    for (let i = 0; i < 45; i += 1) {
      await vi.advanceTimersByTimeAsync(1500);
    }
    const state = store.stateOf(A, B);
    expect(state.resolving).toBe(false);
    expect(state.gaveUp).toBe(true);
    expect(modelApi.mock.calls.length).toBeLessThanOrEqual(42);
  });

  it("stops following a pair when told to", async () => {
    vi.useFakeTimers();
    const store = useCompareStore();
    modelApi.mockResolvedValue(model(true));
    await store.loadModel("v", A, B);
    const asked = modelApi.mock.calls.length;

    store.stopPolling(A, B);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(modelApi.mock.calls.length).toBe(asked);
    expect(store.stateOf(A, B).resolving).toBe(false);
  });

  it("counts a loading file list as busy", async () => {
    const store = useCompareStore();
    const f = deferred<unknown>();
    filesApi.mockReturnValue(f.promise);
    const loading = store.loadFiles("v", A, B);
    expect(store.isResolving(A, B)).toBe(true);
    f.resolve(files(1));
    await loading;
    expect(store.isResolving(A, B)).toBe(false);
  });

  it("forgets everything on reset, polls included", async () => {
    vi.useFakeTimers();
    const store = useCompareStore();
    modelApi.mockResolvedValue(model(true));
    await store.loadModel("v", A, B);
    const asked = modelApi.mock.calls.length;

    store.reset();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(store.stateOf(A, B).model).toBeNull();
    expect(modelApi.mock.calls.length).toBe(asked);
  });
});
