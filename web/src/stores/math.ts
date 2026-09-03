/**
 * The model's math: what it declares, and what that math says.
 *
 * Two fetches with very different costs, which is the whole shape of this store.
 * `loadSources` is a YAML walk and answers immediately, even on a model that
 * does not build — it is what the Model tree's Math group renders, and what the
 * files panel edits. `render` is Calliope's LaTeX backend over the entire
 * formulation, four to eight seconds on an example model, so it is a task in a
 * subprocess and is polled.
 *
 * Rendering is **not** started automatically on load. It costs seconds of CPU
 * and a user who opened the tab to enable a math file has no use for it yet; the
 * tab asks, once, when it is opened. What *is* automatic is noticing the answer
 * has gone stale: the server returns the model's fingerprint with both payloads,
 * and a mismatch means the notation on screen is no longer the notation in the
 * files. Saying so beats either silently re-rendering (seconds of unexplained
 * work) or silently not (wrong math, which looks exactly like right math).
 *
 * A singleton, like `stores/validation.ts` and for the same reason: a window
 * holds one model, and there is no such thing as two readings of its math. The
 * per-key store factory exists for run tabs, which can be open several at once.
 */
import { computed, ref } from "vue";
import { defineStore } from "pinia";

import { cancelTask } from "../api/system";
import { errorDetail } from "../api/errors";
import {
  getMathRender,
  getMathSources,
  startMathRender,
  type MathComponent,
  type MathEnvelope,
  type MathPayload,
  type MathSource,
  type MathSourcesPayload,
} from "../api/versions";

/** Where a render has got to. `idle` also means "never run". */
export type MathPhase = "idle" | "rendering" | "done";

/**
 * What identifies one component, which is its group and its name together.
 *
 * The server already spells provenance this way — `mathdoc._origins` keys on
 * `group:name` for the same reason.
 */
export function componentKey(component: Pick<MathComponent, "group" | "name">): string {
  return `${component.group}:${component.name}`;
}

/**
 * Poll timings, taken from `stores/validation.ts`.
 *
 * A flat interval is wrong in both directions: a cached render answers on the
 * first poll, and a large model takes long enough that 250ms would be hundreds
 * of pointless requests.
 */
const POLL_START_MS = 250;
const POLL_MAX_MS = 2000;
const POLL_GROWTH = 1.6;

export const useMathStore = defineStore("math", () => {
  // ── The cheap half: what the files say ───────────────────────────────────
  const sources = ref<MathSource[]>([]);
  const locations = ref<MathSourcesPayload["components"]>({});
  const sourcesError = ref<string | null>(null);
  const isLoadingSources = ref(false);

  // ── The expensive half: what the math means ──────────────────────────────
  const payload = ref<MathPayload | null>(null);
  const phase = ref<MathPhase>("idle");
  const renderError = ref<string | null>(null);
  const taskId = ref<string | null>(null);

  /** The model fingerprint `payload` was rendered from, and the current one. */
  const renderedFingerprint = ref<string | null>(null);
  const currentFingerprint = ref<string | null>(null);

  // ── View state, held here so the tree can set it before the tab mounts ────
  const sourceFilter = ref<string | null>(null);
  const userOnly = ref(false);
  const query = ref("");
  /** The selected component, as a `group:name` key. */
  const selectedKey = ref<string | null>(null);

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Which model `loadSources` last asked about. */
  let sourcesVersionId: string | null = null;
  /**
   * Bumped on every start and cancel, so a reply already in flight when the
   * user re-renders cannot land in the new run's results.
   */
  let generation = 0;

  /**
   * Whether the rendered math is older than the files it describes.
   *
   * Only ever true once something *has* been rendered: before that there is
   * nothing to be stale, and offering to refresh an empty pane says nothing.
   */
  const isStale = computed(
    () =>
      payload.value !== null &&
      renderedFingerprint.value !== null &&
      currentFingerprint.value !== null &&
      renderedFingerprint.value !== currentFingerprint.value,
  );

  /** Sources that are declared and then never enabled, which do nothing. */
  const unappliedSources = computed(() =>
    sources.value.filter((source) => !source.applied),
  );

  /**
   * Every component, keyed by group and name.
   *
   * A *name* is not unique and this is what selection has to key on. A model
   * that declares `flow_cap` as a parameter and switches the base-math variable
   * of the same name off — the shape of every dispatch model — has two
   * components called `flow_cap`, and a name-keyed map keeps whichever came
   * last, so clicking the deactivated variable showed the parameter instead.
   */
  const componentsByKey = computed(() => {
    const found = new Map<string, MathComponent>();
    for (const group of payload.value?.groups ?? []) {
      for (const component of group.components) found.set(componentKey(component), component);
    }
    return found;
  });

  /**
   * Components by bare name, for following a `Uses` reference.
   *
   * Those references come from the backend and so can only ever name a
   * component that reached it — an active one. Hence the skip rather than a
   * last-writer-wins map: with both a deactivated `flow_cap` variable and an
   * active `flow_cap` parameter in the payload, a `Uses` chip means the
   * parameter, and the deactivated one must not be able to shadow it.
   */
  const componentsByName = computed(() => {
    const found = new Map<string, MathComponent>();
    for (const group of payload.value?.groups ?? []) {
      for (const component of group.components) {
        const existing = found.get(component.name);
        // Keep what is there unless it is deactivated and this one is not, so
        // the answer does not depend on which group happens to come first.
        if (existing && (!existing.deactivated || component.deactivated)) continue;
        found.set(component.name, component);
      }
    }
    return found;
  });

  /** How many components were rendered, deactivated ones included. */
  const componentCount = computed(() =>
    (payload.value?.groups ?? []).reduce((count, group) => count + group.components.length, 0),
  );

  function stopPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  /**
   * What the model's math files declare.
   *
   * Guarded on the same `generation` as `render` and `poll`, which it was not:
   * `reset()` bumps it for a switch to another model, so a sources reply still
   * in flight landed under the new model — and since it carries the *model
   * fingerprint*, `isStale` was then comparing one model's fingerprint against
   * another's and reported the notation on screen as out of date for ever.
   *
   * The model id is checked as well, since two loads can overlap without a
   * `reset()` between them — the Model tree asks on every entry to the section.
   */
  async function loadSources(versionId: string): Promise<void> {
    const mine = generation;
    sourcesVersionId = versionId;
    const current = () => mine === generation && sourcesVersionId === versionId;
    isLoadingSources.value = true;
    sourcesError.value = null;
    try {
      const data = await getMathSources(versionId);
      if (!current()) return;
      sources.value = data.sources;
      locations.value = data.components;
      currentFingerprint.value = data.fingerprint;
    } catch (err) {
      if (!current()) return;
      sourcesError.value = errorDetail(err, "Could not read this model's math.");
    } finally {
      if (current()) isLoadingSources.value = false;
    }
  }

  async function render(versionId: string): Promise<void> {
    if (phase.value === "rendering") return;

    const mine = ++generation;
    stopPolling();
    renderError.value = null;
    taskId.value = null;
    phase.value = "rendering";

    try {
      const envelope = await startMathRender(versionId);
      if (mine !== generation) return;

      // The server hands back a cached rendering when the model has not changed,
      // in which case there is nothing to poll and this is already the answer.
      if (envelope.status === "done" || !envelope.task_id) {
        finish(envelope);
        return;
      }

      taskId.value = envelope.task_id;
      poll(versionId, envelope.task_id, mine, POLL_START_MS);
    } catch (err) {
      if (mine !== generation) return;
      fail(errorDetail(err, "The math could not be rendered."));
    }
  }

  function poll(versionId: string, id: string, mine: number, delay: number) {
    pollTimer = setTimeout(async () => {
      if (mine !== generation) return;
      try {
        const envelope = await getMathRender(versionId, id);
        if (mine !== generation) return;

        if (envelope.status === "done") {
          finish(envelope);
          return;
        }
        poll(versionId, id, mine, Math.min(delay * POLL_GROWTH, POLL_MAX_MS));
      } catch (err) {
        if (mine !== generation) return;
        fail(errorDetail(err, "The math could not be rendered."));
      }
    }, delay);
  }

  function finish(envelope: MathEnvelope) {
    taskId.value = null;
    phase.value = "done";

    if (!envelope.result) {
      // Calliope's own complaint, which is a statement about the model rather
      // than a transport failure — and the most useful thing on the screen when
      // somebody has just written math that does not parse.
      renderError.value = envelope.error ?? "The math could not be rendered.";
      return;
    }

    payload.value = envelope.result;
    renderError.value = null;
    if (envelope.fingerprint) {
      renderedFingerprint.value = envelope.fingerprint;
      currentFingerprint.value = envelope.fingerprint;
    }
    if (selectedKey.value && !componentsByKey.value.has(selectedKey.value)) {
      selectedKey.value = null;
    }
  }

  function fail(message: string) {
    renderError.value = message;
    phase.value = "idle";
    taskId.value = null;
  }

  /**
   * Stops an in-flight render.
   *
   * Generation first, so a poll already on the wire cannot report the killed
   * task. Whatever was rendered before is kept: a cancelled render has no answer
   * of its own, and throwing away the previous one would punish the user for
   * changing their mind.
   */
  async function cancel(): Promise<void> {
    const id = taskId.value;
    generation += 1;
    stopPolling();
    phase.value = payload.value ? "done" : "idle";
    taskId.value = null;
    if (!id) return;
    try {
      await cancelTask(id);
    } catch {
      // Already gone, which is the state we wanted anyway.
    }
  }

  function select(key: string | null) {
    selectedKey.value = key;
  }

  /**
   * Select whatever a `Uses` reference names.
   *
   * The references carry a bare name, because that is all the math itself
   * says; `componentsByName` is what turns one into the component meant.
   */
  function selectByName(name: string) {
    const found = componentsByName.value.get(name);
    selectedKey.value = found ? componentKey(found) : null;
  }

  /**
   * Focus the tab on one math source, as a click in the Model tree does.
   *
   * Clears the component selection: the one that was showing almost certainly
   * belongs to a different source, and leaving it would make the filter look
   * like it had not applied.
   */
  function focusSource(name: string | null) {
    sourceFilter.value = name;
    userOnly.value = false;
    selectedKey.value = null;
  }

  /** Forgets everything, for a switch to another model. */
  function reset() {
    generation += 1;
    stopPolling();
    // A load still in flight declines to touch this once its generation is
    // stale, so if the reset did not clear it the sources pane would spin for
    // the rest of the session on a model that had loaded perfectly well.
    isLoadingSources.value = false;
    sources.value = [];
    locations.value = {};
    payload.value = null;
    phase.value = "idle";
    renderError.value = null;
    sourcesError.value = null;
    taskId.value = null;
    renderedFingerprint.value = null;
    currentFingerprint.value = null;
    sourceFilter.value = null;
    userOnly.value = false;
    query.value = "";
    selectedKey.value = null;
  }

  return {
    sources,
    locations,
    sourcesError,
    isLoadingSources,
    payload,
    phase,
    renderError,
    taskId,
    isStale,
    unappliedSources,
    componentsByKey,
    componentsByName,
    componentCount,
    sourceFilter,
    userOnly,
    query,
    selectedKey,
    loadSources,
    render,
    cancel,
    select,
    selectByName,
    focusSource,
    reset,
  };
});
