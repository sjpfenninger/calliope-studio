/**
 * What differs between two versions of a model, cached per pair.
 *
 * The state lives in a store rather than in the view for two reasons, and both
 * are about the view being `v-if`. A comparison holds no unsaved work, so its
 * pane is torn down whenever another tab comes forward — and a resolve takes
 * seconds, so it has to keep running while the user looks at something else,
 * and its result has to be there when they come back. The tab bar reads the
 * same state to draw its running hairline.
 *
 * Polling follows `composables/useModelGeo.ts` exactly: the server answers
 * immediately with the best reading it has and says whether one is still being
 * built, and this keeps asking until it settles.
 */
import { defineStore } from "pinia";
import { reactive } from "vue";

import {
  getCompareFile,
  getCompareFiles,
  getCompareModel,
  type CompareFiles,
  type CompareModel,
  type FilePair,
} from "@/api/compare";
import { errorDetail } from "@/api/errors";
import { refKey, type CompareRef } from "@/lib/compareRef";

/** While a side is being resolved, how often to ask again. */
const POLL_INTERVAL = 1500;

/** Stop asking eventually, so a wedged resolve does not poll for ever. */
const MAX_POLLS = 40;

interface Entry {
  files: CompareFiles | null;
  model: CompareModel | null;
  filesError: string | null;
  modelError: string | null;
  loadingFiles: boolean;
  loadingModel: boolean;
  /** A side is still being read by Calliope, and we are following it. */
  resolving: boolean;
  /**
   * The polls ran out with a side still unread. Its own flag because the
   * payload goes on saying `pending`, and the view read that alone — so after
   * sixty seconds of a wedged resolve the pane said "Reading the model…" for
   * ever, with nothing in flight and no way to tell.
   */
  gaveUp: boolean;
}

function blank(): Entry {
  return {
    files: null,
    model: null,
    filesError: null,
    modelError: null,
    loadingFiles: false,
    loadingModel: false,
    resolving: false,
    gaveUp: false,
  };
}

/**
 * What a pair nobody has asked about yet looks like.
 *
 * Frozen and shared, so reading the state of an unknown pair — which every
 * consumer does on its first render — neither allocates nor writes to the map.
 */
const NOTHING_YET: Readonly<Entry> = Object.freeze(blank());

export const useCompareStore = defineStore("compare", () => {
  const entries = reactive(new Map<string, Entry>());

  /**
   * Which request owns the answer, per pair **and per half**.
   *
   * A pair can be asked about from three places at once — the view mounting,
   * the tab coming forward, and a poll — and an older response landing last
   * would redraw a comparison the user has already moved past.
   *
   * The two halves need separate counters, and sharing one was a real bug: the
   * files and the model are fetched together, so the model's claim superseded
   * the files' before its response arrived, and the file list threw its own
   * answer away every time. On screen that is a comparison that has loaded and
   * shows nothing — indistinguishable from two versions that agree.
   */
  const generations = { files: new Map<string, number>(), model: new Map<string, number>() };
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const polls = new Map<string, number>();

  /**
   * The state of a pair, for reading.
   *
   * Never inserts. This is called from a computed and from the tab bar's
   * render, and a getter that writes to its own dependency is a loop waiting to
   * happen — quite apart from a tab bar that would populate this store with an
   * entry for every comparison it merely *drew*.
   */
  function stateOf(a: CompareRef, b: CompareRef): Readonly<Entry> {
    return entries.get(refKey(a, b)) ?? NOTHING_YET;
  }

  /**
   * The state of a pair, for writing.
   *
   * **Reads back through the map rather than returning what it just inserted.**
   * `reactive(new Map())` stores the raw object and hands out a proxy, so a
   * loader mutating the object it created would write straight past the
   * reactivity: every value would be correct on inspection and nothing on
   * screen would ever update. That is exactly what happened — a comparison
   * whose files had arrived went on rendering as though they had not.
   */
  function ensure(a: CompareRef, b: CompareRef): Entry {
    const key = refKey(a, b);
    if (!entries.has(key)) entries.set(key, blank());
    return entries.get(key)!;
  }

  function isResolving(a: CompareRef, b: CompareRef): boolean {
    const found = stateOf(a, b);
    return Boolean(found.resolving || found.loadingModel || found.loadingFiles);
  }

  function stopPollingKey(key: string) {
    const timer = timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(key);
  }

  /**
   * Stops following a pair. For a compare tab being closed: nothing else
   * reaches the timer, so a comparison closed mid-resolve went on asking
   * about it for up to a minute.
   */
  function stopPolling(a: CompareRef, b: CompareRef) {
    const key = refKey(a, b);
    stopPollingKey(key);
    const found = entries.get(key);
    if (found) found.resolving = false;
  }

  function claim(half: "files" | "model", key: string): number {
    const counters = generations[half];
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  }

  const owns = (half: "files" | "model", key: string, mine: number) =>
    generations[half].get(key) === mine;

  async function loadFiles(versionId: string, a: CompareRef, b: CompareRef) {
    const key = refKey(a, b);
    const state = ensure(a, b);
    const mine = claim("files", key);
    state.loadingFiles = true;
    state.filesError = null;
    try {
      const payload = await getCompareFiles(versionId, a, b);
      if (!owns("files", key, mine)) return;
      state.files = payload;
    } catch (caught) {
      if (!owns("files", key, mine)) return;
      state.files = null;
      state.filesError = errorDetail(caught, "Could not compare these versions.");
    } finally {
      if (owns("files", key, mine)) state.loadingFiles = false;
    }
  }

  async function loadModel(
    versionId: string,
    a: CompareRef,
    b: CompareRef,
    continuing = false,
  ) {
    const key = refKey(a, b);
    const state = ensure(a, b);
    stopPollingKey(key);
    if (!continuing) {
      polls.set(key, 0);
      state.gaveUp = false;
    }

    const mine = claim("model", key);
    state.loadingModel = !continuing;
    state.modelError = null;
    try {
      const payload = await getCompareModel(versionId, a, b);
      if (!owns("model", key, mine)) return;
      state.model = payload;

      const asked = polls.get(key) ?? 0;
      if (payload.pending && asked < MAX_POLLS) {
        polls.set(key, asked + 1);
        state.resolving = true;
        timers.set(
          key,
          setTimeout(() => void loadModel(versionId, a, b, true), POLL_INTERVAL),
        );
      } else {
        state.resolving = false;
        state.gaveUp = Boolean(payload.pending);
        polls.set(key, 0);
      }
    } catch (caught) {
      if (!owns("model", key, mine)) return;
      state.model = null;
      state.resolving = false;
      state.modelError = errorDetail(caught, "Could not compare these models.");
    } finally {
      if (owns("model", key, mine)) state.loadingModel = false;
    }
  }

  function file(
    versionId: string,
    a: CompareRef,
    b: CompareRef,
    path: string,
  ): Promise<FilePair> {
    return getCompareFile(versionId, a, b, path);
  }

  /** Throws away what is known about a pair and asks again. */
  async function refresh(versionId: string, a: CompareRef, b: CompareRef) {
    const key = refKey(a, b);
    stopPollingKey(key);
    entries.set(key, blank());
    await loadFiles(versionId, a, b);
    await loadModel(versionId, a, b);
  }

  /** On a model change: nothing here describes the new one. */
  function reset() {
    for (const key of [...timers.keys()]) stopPollingKey(key);
    entries.clear();
    generations.files.clear();
    generations.model.clear();
    polls.clear();
  }

  return {
    entries,
    stateOf,
    isResolving,
    loadFiles,
    loadModel,
    file,
    refresh,
    stopPolling,
    reset,
  };
});
