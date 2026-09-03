import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/versions", () => ({ listFiles: vi.fn() }));

import { listFiles } from "../api/versions";
import { useVersionStore, type FileEntry } from "./version";

const fetchFiles = vi.mocked(listFiles);

function entry(path: string): FileEntry {
  return { path, type: "yaml", size: 10 } as FileEntry;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * The workspace's file listing, and the model switch that races it.
 *
 * The listing is fetched from a watcher on the route's model id, so two are in
 * flight whenever a switch happens faster than the server answers. Nothing
 * checked which one had come back, so the file tree could end up showing the
 * files of the model the user had just left, under the id of the one they are
 * looking at — and since `sizeOf` reads the same list, the binary viewer would
 * then report a size from the wrong file.
 */
describe("useVersionStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fetchFiles.mockReset();
  });

  it("lets the newest request win, whatever order the replies land in", async () => {
    const store = useVersionStore();
    const a = deferred<FileEntry[]>();
    const b = deferred<FileEntry[]>();
    fetchFiles.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

    const first = store.loadFileTree("A");
    const second = store.loadFileTree("B");

    b.resolve([entry("b.yaml")]);
    await second;
    a.resolve([entry("a.yaml")]);
    await first;

    expect(store.files.map((file) => file.path)).toEqual(["b.yaml"]);
    expect(store.isLoading).toBe(false);
  });

  it("keeps the spinner up until the request that matters answers", async () => {
    const store = useVersionStore();
    const a = deferred<FileEntry[]>();
    const b = deferred<FileEntry[]>();
    fetchFiles.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

    const first = store.loadFileTree("A");
    const second = store.loadFileTree("B");

    a.resolve([entry("a.yaml")]);
    await first;
    expect(store.isLoading).toBe(true);

    b.resolve([entry("b.yaml")]);
    await second;
    expect(store.isLoading).toBe(false);
  });

  it("does not let a superseded failure blank the tree", async () => {
    // The failing path is the worse half of the race: A's rejection landing
    // after B's listing emptied the tree *and* raised an error against a model
    // whose files had loaded perfectly well.
    const store = useVersionStore();
    const a = deferred<FileEntry[]>();
    fetchFiles.mockReturnValueOnce(
      a.promise.then(() => {
        throw new Error("gone");
      }),
    );
    fetchFiles.mockResolvedValueOnce([entry("b.yaml")]);

    const first = store.loadFileTree("A");
    await store.loadFileTree("B");
    a.resolve([]);
    await first;

    expect(store.files.map((file) => file.path)).toEqual(["b.yaml"]);
    expect(store.error).toBeNull();
  });

  it("reports a failed listing rather than looking like an empty model", async () => {
    const store = useVersionStore();
    fetchFiles.mockRejectedValue(new Error("connection refused"));

    await store.loadFileTree("A");

    expect(store.error).toBe("connection refused");
    expect(store.files).toEqual([]);
    expect(store.fileTree).toEqual([]);
  });
});
