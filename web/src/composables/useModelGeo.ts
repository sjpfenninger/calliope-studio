import { onMounted, onScopeDispose, ref, watch, type Ref } from "vue";

import { errorDetail } from "../api/errors";
import { getGeo } from "../api/versions";
import type { GeoPayload } from "../lib/mapGeo";

/** How the server got the geometry it sent. */
export type GeoSource = "resolved" | "stale" | "structural";

/** While a resolve is running, how often to ask again. */
const POLL_INTERVAL = 1500;

/** Stop asking eventually, so a wedged resolve does not poll for ever. */
const MAX_POLLS = 40;

interface GeoResponse extends GeoPayload {
  source?: GeoSource;
  resolve_task?: string;
  resolve_error?: string;
}

/**
 * The saved geography of a model definition.
 *
 * What the editors get from this is everything they do *not* hold themselves: the
 * nodes and links defined in files this editor never loaded, and the technology
 * colours. Live geometry comes from `lib/mapGeo`'s `buildGeo` over the editor's
 * own entries, because the point of an editing map is to show what has not been
 * saved yet.
 *
 * The server answers immediately with the best reading it has and says which one
 * that is. When it reports a resolve in flight — Calliope reading the model in a
 * subprocess, a few seconds on a real one — this keeps asking until it settles, so
 * the map fills in on its own rather than needing a reload.
 *
 * `error` is exposed rather than swallowed. The previous version turned any
 * failure into `geo = null`, which is indistinguishable from a model with no
 * geography — so a 500 looked exactly like an empty map and said nothing.
 */
export function useModelGeo(versionId: Ref<string>) {
  const geo = ref<GeoPayload | null>(null);
  const source = ref<GeoSource>("structural");
  const error = ref<string | null>(null);
  /** Whether a resolve is in flight and being followed, for a hairline to show. */
  const resolving = ref(false);

  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * How many times *this* poll sequence has asked again.
   *
   * Reset by `reload` rather than only by the version watch, which is what it
   * counts: a save is a fresh question, not a continuation of the previous
   * one. Counted across every call it was a budget for the lifetime of the
   * tab, so on a model slow enough to need a few polls per save the map simply
   * stopped following saves after forty of them, with nothing to say why.
   */
  let polls = 0;
  /**
   * Which call owns the answer, and whether this composable is still alive.
   *
   * `stopPolling` only ever cleared a pending timer, never an outstanding
   * request — and `reload` is called from three places at once: the poll, the
   * `versionId` watch, and every editor's `after()` hook. Three consequences,
   * all of which happened. An older response landing last redrew the *pre-save*
   * geometry. Two responses both seeing `resolve_task` each assigned `timer`,
   * orphaning the first handle and doubling the poll rate every round. And a
   * response that resolved after `onScopeDispose` scheduled a fresh timer, so a
   * closed tab went on asking for `/geo/` up to `MAX_POLLS` times.
   *
   * `stores/validation.ts` is the model this now follows.
   */
  let generation = 0;
  let alive = true;

  function stopPolling() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  async function reload(continuing = false): Promise<void> {
    stopPolling();
    if (!continuing) polls = 0;
    const mine = ++generation;
    error.value = null;
    try {
      const { source: from, resolve_task, resolve_error, ...payload } =
        await getGeo<GeoResponse>(versionId.value!);
      if (mine !== generation || !alive) return;
      geo.value = payload as GeoPayload;
      source.value = from ?? "resolved";
      error.value = resolve_error ?? null;

      if (resolve_task && polls < MAX_POLLS) {
        polls += 1;
        resolving.value = true;
        timer = setTimeout(() => void reload(true), POLL_INTERVAL);
      } else {
        polls = 0;
        resolving.value = false;
      }
    } catch (caught) {
      if (mine !== generation || !alive) return;
      geo.value = null;
      resolving.value = false;
      error.value = errorDetail(caught, "Could not read the model's geography.");
    }
  }

  onMounted(() => void reload());
  watch(versionId, () => void reload());
  onScopeDispose(() => {
    alive = false;
    generation += 1;
    stopPolling();
  });

  return { geo, source, error, resolving, reload };
}
