import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/versions", () => ({ getComponentTree: vi.fn() }));

import { getComponentTree, type ComponentTree } from "../api/versions";
import { useComponentTreeStore } from "./componentTree";

const fetchTree = vi.mocked(getComponentTree);

function tree(name: string): ComponentTree {
  return { sections: [{ name, entries: [] }] } as unknown as ComponentTree;
}

/** A promise plus the handles to settle it, so two loads can be interleaved. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The component tree, and what happens when the user changes model mid-request.
 *
 * This store used to assign whatever the awaited call returned and then set
 * `loadedVersionId` to the model it had asked about — so a slow reply for the
 * model just left overwrote the one now open *and* stamped it with the old id,
 * which made the early return at the top of `load` refuse to fetch the right
 * one. The Model column showed another model's technologies until somebody
 * pressed refresh, and nothing on screen suggested anything had gone wrong.
 */
describe("useComponentTreeStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fetchTree.mockReset();
  });

  it("lets the newest request win, whatever order the replies land in", async () => {
    const store = useComponentTreeStore();
    const a = deferred<ComponentTree>();
    const b = deferred<ComponentTree>();
    fetchTree.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

    const first = store.load("A");
    const second = store.load("B");

    b.resolve(tree("B"));
    await second;
    a.resolve(tree("A"));
    await first;

    expect(store.tree).toEqual(tree("B"));
    // Stamped B as well: stamped A, the guard at the top of `load` would treat
    // B's tree as A's and never fetch B again.
    expect(store.isLoading).toBe(false);
  });

  it("keeps the spinner up until the request that matters answers", async () => {
    // The first of two overlapping loads used to clear `isLoading` in its own
    // `finally`, so the tree read "loaded" while the model on screen had not
    // been fetched at all.
    const store = useComponentTreeStore();
    const a = deferred<ComponentTree>();
    const b = deferred<ComponentTree>();
    fetchTree.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

    const first = store.load("A");
    const second = store.load("B");

    a.resolve(tree("A"));
    await first;
    expect(store.isLoading).toBe(true);

    b.resolve(tree("B"));
    await second;
    expect(store.isLoading).toBe(false);
  });

  it("says what went wrong rather than showing an empty model", async () => {
    // There was no `error` at all: a failure became `tree = null`, which is
    // exactly what a model with no sections looks like.
    const store = useComponentTreeStore();
    fetchTree.mockRejectedValue(new Error("connection refused"));

    await store.load("A");

    expect(store.error).toBe("connection refused");
    expect(store.tree).toBeNull();
    expect(store.isLoading).toBe(false);
  });

  it("refetches after a failure, rather than believing it has the tree", async () => {
    const store = useComponentTreeStore();
    fetchTree.mockRejectedValueOnce(new Error("nope"));
    await store.load("A");

    fetchTree.mockResolvedValueOnce(tree("A"));
    await store.load("A");

    expect(store.tree).toEqual(tree("A"));
    expect(store.error).toBeNull();
  });

  it("does not refetch a model it already holds", async () => {
    const store = useComponentTreeStore();
    fetchTree.mockResolvedValue(tree("A"));

    await store.load("A");
    await store.load("A");

    expect(fetchTree).toHaveBeenCalledTimes(1);
  });
});
