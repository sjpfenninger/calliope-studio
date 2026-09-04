import { computed, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from "vue";

/**
 * The one entry an entry tab shows, held by identity rather than looked up by
 * name on every render.
 *
 * Every entry editor filtered `entries` on `entry.name === entryName`, and the
 * name field is `v-model` on that same `entry.name` — so the first keystroke
 * of a rename filtered the row out from under the cursor. The accordion
 * unmounted, focus went with it, the pane said "No technology called …", and
 * the half-typed name survived only in `entries`, invisible, with the tab
 * marked dirty over an editor showing nothing. `DataTablesEditor` lost its CSV
 * grid the same way, since the grid's path was derived from the vanished row.
 *
 * `NodesEditor` and `LinksEditor` already hold the map's selection this way
 * and say why; this is the same rule for the entry tab, so the six editors
 * cannot drift apart on it again.
 *
 * Re-pinned by name whenever the tab's name or the loaded list changes — a
 * reload replaces `entries.value` wholesale — and dropped when the entry is
 * removed, which is the one honest reason for the pane to say it is gone.
 */
export function usePinnedEntry<T extends { name: string }>(
  entries: Ref<T[]>,
  entryName: () => string | null | undefined,
): { pinned: ShallowRef<T | null>; visible: ComputedRef<T[]> } {
  const pinned = shallowRef(null) as ShallowRef<T | null>;

  watch(
    [entryName, entries],
    ([name, all]) => {
      pinned.value = name ? (all.find((entry) => entry.name === name) ?? null) : null;
    },
    { immediate: true },
  );

  const visible = computed(() => {
    if (!entryName()) return entries.value;
    const entry = pinned.value;
    return entry && entries.value.includes(entry) ? [entry] : [];
  });

  return { pinned, visible };
}
