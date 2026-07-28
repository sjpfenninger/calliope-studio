/**
 * The small pieces every figure header needs, once.
 *
 * These lived inside `RunResultsPanel.vue` while it was the only thing with
 * variable and aggregation toggles. The table has the same controls over the same
 * store, and a second copy of `keepOne` — the thing standing between a toggle
 * group and a chart blanked with no way back — is one copy too many.
 */
import type { SumBy } from "../stores/runSelection";

/** How each sum-by option is labelled, in the order the toggles offer them. */
export const SUM_LABELS: Record<SumBy, string> = {
  none: "No sum",
  nodes: "Sum nodes",
  techs: "Sum techs",
};

/**
 * Shorter labels for the resolutions, where the key is the API into `RESOLUTIONS`
 * and not a caption.
 *
 * "Original resolution" alone is wide enough to push a figure header onto a
 * second row, which makes it half as tall again as the ones beside it — and a
 * collapsed figure is exactly its title bar, so the difference is not only
 * visible while everything is open.
 */
export const RESOLUTION_LABELS: Record<string, string> = {
  "Original resolution": "Original",
};

/**
 * Reproduces PrimeVue's `:allow-empty="false"`.
 *
 * A toggle group deselects on a second click, and "no plot type" is not a state
 * these views have — it would blank the figure with no way back except guessing.
 */
export function keepOne<T extends string>(next: unknown, current: T): T {
  return (next as T) || current;
}
