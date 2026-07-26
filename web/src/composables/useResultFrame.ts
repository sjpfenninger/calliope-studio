import { ref, shallowRef, watch, onScopeDispose, type Ref } from "vue";
import { streamFrame, type ResultFrame, type ResultQuery } from "../api/results";

/**
 * Keeps a chart's data in step with its query.
 *
 * A figure owns a query; this owns the consequences of changing it. Changing a
 * filter aborts whatever is still in flight rather than racing it, and batches
 * are surfaced as they arrive so a long timeseries paints progressively instead
 * of appearing all at once at the end.
 */
export function useResultFrame(
  handle: Ref<string | null>,
  query: Ref<ResultQuery | null>,
) {
  const frame = shallowRef<ResultFrame | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  let controller: AbortController | null = null;

  function cancelInFlight() {
    controller?.abort();
    controller = null;
  }

  async function load() {
    cancelInFlight();
    if (!handle.value || !query.value) {
      frame.value = null;
      return;
    }

    const request = new AbortController();
    controller = request;
    loading.value = true;
    error.value = null;

    try {
      for await (const next of streamFrame(
        handle.value,
        query.value,
        request.signal,
      )) {
        // A late batch from a superseded request must not overwrite the
        // current one.
        if (request.signal.aborted) return;
        frame.value = next;
      }
    } catch (caught) {
      if ((caught as Error)?.name === "AbortError") return;
      error.value = (caught as Error).message ?? String(caught);
      frame.value = null;
    } finally {
      if (controller === request) {
        controller = null;
        loading.value = false;
      }
    }
  }

  watch([handle, query], load, { immediate: true, deep: true });
  onScopeDispose(cancelInFlight);

  return { frame, loading, error, reload: load };
}
