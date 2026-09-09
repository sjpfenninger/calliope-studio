/**
 * What differs from the last commit, and the commits before it.
 *
 * One store for one model: a window holds one model, and its git state is a
 * fact about the folder rather than about any tab. Three surfaces read it —
 * the file tree's markers, the sidebar's footer and the changes tab — and a
 * singleton is what keeps their counts the same number.
 *
 * Refreshed from two signals and never from a timer. `api/writeSignal`
 * fires on every successful write to the model through this app; the
 * window's focus event covers the user's terminal, which is the other place
 * they edit. Both are debounced into one `git status`, because a structured
 * save is two writes and a commit is a write followed by its own refresh.
 */
import { computed, ref, shallowReactive } from "vue";
import { defineStore } from "pinia";

import { errorDetail } from "../api/errors";
import * as api from "../api/vcs";
import type {
  VcsChange,
  VcsCommit,
  VcsCommitDetail,
  VcsState,
  VcsStatus,
} from "../api/vcs";
import { onVersionWrite } from "../api/writeSignal";
import { changedUnder, changesByPath } from "../lib/vcsStatus";

export type { VcsChange, VcsCommit, VcsCommitDetail, VcsState, VcsStatus };

/** How long after the last write to wait before asking git. */
const REFRESH_DEBOUNCE_MS = 250;

/** How much history the sidebar lists. The tab can ask for more. */
export const LOG_LIMIT = 50;

export const useVcsStore = defineStore("vcs", () => {
  const versionId = ref<string | null>(null);
  const status = ref<VcsStatus | null>(null);
  const changes = ref<VcsChange[]>([]);
  const log = ref<VcsCommit[]>([]);
  /** One commit's detail, by sha. A commit is immutable, so never evicted. */
  const commits = shallowReactive(new Map<string, VcsCommitDetail>());
  const loading = ref(false);
  /** An init, a commit or a discard in flight; the buttons disable on it. */
  const busy = ref(false);
  /** A transport failure, which is not a statement about the repository. */
  const error = ref<string | null>(null);

  /** The two sidebar disclosures. Not persisted: a session-level fold. */
  const changesOpen = ref(true);
  const historyOpen = ref(false);
  /** Whether the next run commits first. Per session, deliberately. */
  const commitBeforeRun = ref(false);

  const state = computed<VcsState | null>(() => status.value?.state ?? null);
  /** There is a git, and it will answer for this folder. */
  const ready = computed(() => status.value?.tracked === true);
  /** There is a git at all; the chrome is absent otherwise. */
  const available = computed(() => status.value?.available === true);
  const branch = computed(() => status.value?.branch ?? null);
  const changedCount = computed(() => changes.value.length);
  const byPath = computed(() => changesByPath(changes.value));

  /** The change on one file, for the tree's marker. */
  function changeFor(path: string): VcsChange | undefined {
    return byPath.value.get(path);
  }

  /** How many changed files sit under a folder, for its row. */
  function countUnder(dir: string): number {
    return changedUnder(changes.value, dir);
  }

  /**
   * Which refresh owns the answer. Two can be in flight — a write signal
   * landing while a focus refresh is out — and the older must not overwrite
   * the newer, or a commit's zero shows up and is then replaced by the count
   * from before it.
   */
  let generation = 0;

  /**
   * Which HEAD the log on hand was read for.
   *
   * Compared against the *fetched* log rather than against `status.head`,
   * because two refreshes overlap after every commit — the commit's own, and
   * the write signal's a quarter-second later. The second saw the status the
   * first had already stored, decided HEAD had not moved, kept the old log,
   * and then won the generation check: History led with the previous commit
   * until something else moved HEAD.
   */
  let logHead: string | null | undefined;

  async function refresh(): Promise<void> {
    const id = versionId.value;
    if (!id) return;
    const mine = ++generation;
    loading.value = true;
    error.value = null;
    try {
      const found = await api.getVcsStatus(id);
      if (mine !== generation) return;
      status.value = found;
      if (!found.tracked) {
        changes.value = [];
        log.value = [];
        logHead = undefined;
        return;
      }
      // The log only moves when HEAD does, so it is not re-read on every save.
      const stale = logHead === undefined || found.head !== logHead;
      const [listing, history] = await Promise.all([
        api.getVcsChanges(id),
        stale ? api.getVcsLog(id, { limit: LOG_LIMIT }) : Promise.resolve(log.value),
      ]);
      if (mine !== generation) return;
      changes.value = listing.files;
      log.value = history;
      logHead = found.head;
    } catch (caught) {
      if (mine !== generation) return;
      error.value = errorDetail(caught, "Could not read the repository.");
    } finally {
      if (mine === generation) loading.value = false;
    }
  }

  /** The model to describe. A different model drops everything first. */
  async function load(id: string): Promise<void> {
    if (versionId.value !== id) reset();
    versionId.value = id;
    await refresh();
  }

  function reset(): void {
    generation += 1;
    versionId.value = null;
    status.value = null;
    changes.value = [];
    log.value = [];
    logHead = undefined;
    commits.clear();
    error.value = null;
    loading.value = false;
    busy.value = false;
  }

  async function act<T>(action: () => Promise<T>): Promise<T> {
    busy.value = true;
    try {
      return await action();
    } finally {
      busy.value = false;
    }
  }

  async function init(): Promise<void> {
    const id = versionId.value;
    if (!id) return;
    await act(() => api.initVcs(id));
    await refresh();
  }

  /** Commits the paths given, or everything, and returns the new sha. */
  async function commit(message: string, paths?: string[]): Promise<string> {
    const id = versionId.value;
    if (!id) throw new Error("No model is open — nothing was committed.");
    const { sha } = await act(() => api.commitVcs(id, message, paths));
    await refresh();
    return sha;
  }

  async function discard(path: string): Promise<void> {
    const id = versionId.value;
    if (!id) return;
    await act(() => api.discardVcs(id, path));
    await refresh();
  }

  /** One commit, fetched once. Throws for a commit that is no longer there. */
  async function commitDetail(sha: string): Promise<VcsCommitDetail> {
    const id = versionId.value;
    if (!id) throw new Error("No model is open.");
    const known = commits.get(sha);
    if (known) return known;
    const found = await api.getVcsCommit(id, sha);
    commits.set(found.commit.sha, found);
    if (found.commit.sha !== sha) commits.set(sha, found);
    return found;
  }

  // -- staleness -------------------------------------------------------------

  let pending: ReturnType<typeof setTimeout> | null = null;

  function schedule(): void {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  // A write can only change what git says about a folder git already
  // answers for; a folder that became a repository in a terminal is caught
  // by the focus refresh below.
  onVersionWrite(() => {
    if (ready.value) schedule();
  });

  if (typeof window !== "undefined") {
    window.addEventListener("focus", () => {
      if (versionId.value) schedule();
    });
  }

  return {
    versionId,
    status,
    changes,
    log,
    commits,
    loading,
    busy,
    error,
    changesOpen,
    historyOpen,
    commitBeforeRun,
    state,
    ready,
    available,
    branch,
    changedCount,
    changeFor,
    countUnder,
    load,
    refresh,
    reset,
    init,
    commit,
    discard,
    commitDetail,
  };
});
