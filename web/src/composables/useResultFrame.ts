import { computed, ref, shallowRef, watch, onScopeDispose, type Ref } from "vue";
import { errorDetail } from "../api/errors";
import { streamFrame, type ResultFrame, type ResultQuery } from "../api/results";
import { resolveUnit, scaleFrame, type DisplayUnit } from "../lib/units";
import { useUnitsStore } from "../stores/units";

/**
 * Keeps a chart's data in step with its query.
 *
 * A figure owns a query; this owns the consequences of changing it. Changing a
 * filter aborts whatever is still in flight rather than racing it, and batches
 * are surfaced as they arrive so a long timeseries paints progressively instead
 * of appearing all at once at the end.
 *
 * It is also where the display unit is applied, because it is the one place
 * every frame in the application passes through — the results panel makes five
 * here and the table one, and chart, table, CSV and map all read what they
 * return. Applied here rather than sent with the query, so changing "energy" to
 * GWh rescales six figures without a single request to the server.
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
      // The abort above nulls `controller`, so the aborted request's `finally`
      // no longer recognises itself and leaves `loading` true — for ever, since
      // nothing else will run. Pick a map colour variable and then a pie one
      // before the first frame lands (the colour query goes null) and the
      // spinner never stopped.
      loading.value = false;
      error.value = null;
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
      error.value = errorDetail(caught, "Could not read the results.");
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

  const units = useUnitsStore();

  // Read off the frame itself, which the server stamps with the variable's
  // declared unit, so this needs no catalogue and cannot race one.
  const unit = computed<DisplayUnit>(() =>
    resolveUnit(frame.value?.unit, units.prefs),
  );
  const scaled = computed(() => scaleFrame(frame.value, unit.value.factor));

  // `frame` is the scaled one so that no consumer can forget to apply it, and
  // so a figure and the CSV beside it can never disagree. `raw` is there for
  // anything that genuinely wants model values.
  return { frame: scaled, raw: frame, unit, loading, error, reload: load };
}
