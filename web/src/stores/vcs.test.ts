import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/vcs", () => ({
  getVcsStatus: vi.fn(),
  getVcsChanges: vi.fn(),
  getVcsLog: vi.fn(),
  getVcsCommit: vi.fn(),
  initVcs: vi.fn(),
  commitVcs: vi.fn(),
  discardVcs: vi.fn(),
}));

import * as api from "../api/vcs";
import type { VcsCommit, VcsStatus } from "../api/vcs";
import { useVcsStore } from "./vcs";

const mocked = api as unknown as Record<keyof typeof api, ReturnType<typeof vi.fn>>;

function status(over: Partial<VcsStatus> = {}): VcsStatus {
  return {
    available: true,
    tracked: true,
    state: "ready",
    root: "/models/m",
    branch: "main",
    detached: false,
    nested: false,
    changed: 0,
    head: "aaaa",
    gitignore: null,
    ...over,
  };
}

function commit(sha: string): VcsCommit {
  return { sha, short: sha.slice(0, 7), author: "Me", date: "2026-09-08T10:00:00+02:00", subject: sha, body: "" };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Three surfaces read this store and a stale count looks exactly like a
 * clean tree, so what is pinned is the refresh: what it re-reads, what it
 * keeps, and which of two overlapping refreshes gets to say.
 */
describe("useVcsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocked.getVcsChanges.mockResolvedValue({ head: "aaaa", files: [] });
  });

  it("reads the status, the changes and the log for a tracked folder", async () => {
    mocked.getVcsStatus.mockResolvedValue(status());
    mocked.getVcsLog.mockResolvedValue([commit("aaaa")]);
    const vcs = useVcsStore();
    await vcs.load("m");
    expect(vcs.ready).toBe(true);
    expect(vcs.branch).toBe("main");
    expect(vcs.log.map((entry) => entry.sha)).toEqual(["aaaa"]);
  });

  it("lists nothing for a folder git does not answer for", async () => {
    mocked.getVcsStatus.mockResolvedValue(status({ tracked: false, state: "untracked" }));
    const vcs = useVcsStore();
    await vcs.load("m");
    expect(vcs.ready).toBe(false);
    expect(mocked.getVcsChanges).not.toHaveBeenCalled();
    expect(mocked.getVcsLog).not.toHaveBeenCalled();
  });

  it("re-reads the log only when HEAD moves", async () => {
    mocked.getVcsStatus.mockResolvedValue(status());
    mocked.getVcsLog.mockResolvedValue([commit("aaaa")]);
    const vcs = useVcsStore();
    await vcs.load("m");
    await vcs.refresh();
    expect(mocked.getVcsLog).toHaveBeenCalledTimes(1);

    mocked.getVcsStatus.mockResolvedValue(status({ head: "bbbb" }));
    mocked.getVcsLog.mockResolvedValue([commit("bbbb"), commit("aaaa")]);
    await vcs.refresh();
    expect(mocked.getVcsLog).toHaveBeenCalledTimes(2);
    expect(vcs.log[0].sha).toBe("bbbb");
  });

  it("does not let a later refresh keep the log an earlier one was still fetching", async () => {
    // After a commit two refreshes overlap: the commit's own, and the write
    // signal's a moment later. The second must not read "HEAD unchanged" off
    // the status the first stored and then win the race with the old log.
    mocked.getVcsStatus.mockResolvedValue(status());
    mocked.getVcsLog.mockResolvedValue([commit("aaaa")]);
    const vcs = useVcsStore();
    await vcs.load("m");

    mocked.getVcsStatus.mockResolvedValue(status({ head: "bbbb" }));
    let release: (log: VcsCommit[]) => void = () => {};
    mocked.getVcsLog
      .mockImplementationOnce(() => new Promise<VcsCommit[]>((resolve) => (release = resolve)))
      .mockResolvedValueOnce([commit("bbbb"), commit("aaaa")]);

    const first = vcs.refresh();
    await tick();
    expect(vcs.status?.head).toBe("bbbb");
    const second = vcs.refresh();
    release([commit("bbbb"), commit("aaaa")]);
    await Promise.all([first, second]);

    expect(mocked.getVcsLog).toHaveBeenCalledTimes(3);
    expect(vcs.log[0].sha).toBe("bbbb");
  });

  it("counts a folder's changes and marks a file", async () => {
    mocked.getVcsStatus.mockResolvedValue(status({ changed: 2 }));
    mocked.getVcsChanges.mockResolvedValue({
      head: "aaaa",
      files: [
        { path: "model.yaml", index: " ", worktree: "M", state: "modified", original: null },
        { path: "data/x.csv", index: "?", worktree: "?", state: "untracked", original: null },
      ],
    });
    mocked.getVcsLog.mockResolvedValue([]);
    const vcs = useVcsStore();
    await vcs.load("m");
    expect(vcs.changedCount).toBe(2);
    expect(vcs.changeFor("model.yaml")?.state).toBe("modified");
    expect(vcs.countUnder("data")).toBe(1);
  });

  it("caches a commit's detail, which cannot change", async () => {
    mocked.getVcsStatus.mockResolvedValue(status());
    mocked.getVcsLog.mockResolvedValue([]);
    mocked.getVcsCommit.mockResolvedValue({ commit: commit("aaaa"), parent: null, files: [] });
    const vcs = useVcsStore();
    await vcs.load("m");
    await vcs.commitDetail("aaaa");
    await vcs.commitDetail("aaaa");
    expect(mocked.getVcsCommit).toHaveBeenCalledTimes(1);
  });

  it("commits, re-reads everything, and hands back the sha", async () => {
    mocked.getVcsStatus.mockResolvedValue(status({ changed: 1 }));
    mocked.getVcsLog.mockResolvedValue([commit("aaaa")]);
    const vcs = useVcsStore();
    await vcs.load("m");

    mocked.commitVcs.mockResolvedValue({ sha: "bbbb", short: "bbbb" });
    mocked.getVcsStatus.mockResolvedValue(status({ head: "bbbb" }));
    mocked.getVcsLog.mockResolvedValue([commit("bbbb"), commit("aaaa")]);
    expect(await vcs.commit("Tighten techs", ["model.yaml"])).toBe("bbbb");

    expect(mocked.commitVcs).toHaveBeenCalledWith("m", "Tighten techs", ["model.yaml"]);
    expect(vcs.log[0].sha).toBe("bbbb");
    expect(vcs.busy).toBe(false);
  });

  it("discards through the API and re-reads the changes", async () => {
    mocked.getVcsStatus.mockResolvedValue(status({ changed: 1 }));
    mocked.getVcsLog.mockResolvedValue([commit("aaaa")]);
    const vcs = useVcsStore();
    await vcs.load("m");
    mocked.discardVcs.mockResolvedValue(undefined);
    await vcs.discard("model.yaml");
    expect(mocked.discardVcs).toHaveBeenCalledWith("m", "model.yaml");
    expect(mocked.getVcsChanges).toHaveBeenCalledTimes(2);
  });

  it("tracks a folder and becomes ready", async () => {
    mocked.getVcsStatus.mockResolvedValue(status({ tracked: false, state: "untracked" }));
    const vcs = useVcsStore();
    await vcs.load("m");
    expect(vcs.ready).toBe(false);

    mocked.initVcs.mockResolvedValue(status());
    mocked.getVcsStatus.mockResolvedValue(status());
    mocked.getVcsLog.mockResolvedValue([commit("aaaa")]);
    await vcs.init();
    expect(mocked.initVcs).toHaveBeenCalledWith("m");
    expect(vcs.ready).toBe(true);
    expect(vcs.log).toHaveLength(1);
  });

  it("reports a repository it cannot read, and stops loading", async () => {
    mocked.getVcsStatus.mockRejectedValue(new Error("git exploded"));
    const vcs = useVcsStore();
    await vcs.load("m");
    expect(vcs.error).toBe("git exploded");
    expect(vcs.loading).toBe(false);
    expect(vcs.ready).toBe(false);
  });

  it("clears busy when an action fails, so the buttons come back", async () => {
    mocked.getVcsStatus.mockResolvedValue(status({ changed: 1 }));
    mocked.getVcsLog.mockResolvedValue([]);
    const vcs = useVcsStore();
    await vcs.load("m");
    mocked.commitVcs.mockRejectedValue(new Error("index.lock"));
    await expect(vcs.commit("x")).rejects.toThrow("index.lock");
    expect(vcs.busy).toBe(false);
  });
});
