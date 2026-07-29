import { computed, watch, type Ref } from "vue";

import { ancestorKeys, branchKeys, filterTree, type TreeNodeLike } from "@/lib/treeFilter";
import { useExplorerStore, type ExplorerTree } from "@/stores/explorer";

/**
 * The filter field, the pruned tree and the expansion that goes with it.
 *
 * Both explorer sections need the same four things wired the same way, and the
 * wiring is the part with the sharp edge in it — a search has to reveal its
 * matches without destroying the expansion the user had before they typed. Two
 * copies of that would be two chances to get it wrong.
 */
export function useTreeSearch<T extends TreeNodeLike<T>>(
  tree: ExplorerTree,
  source: Ref<T[]>,
  getSearchText: (item: T) => string,
  selected: Ref<T | undefined>,
) {
  const explorer = useExplorerStore();

  const query = computed({
    get: () => explorer.query[tree],
    set: (next: string) => explorer.setQuery(tree, next),
  });

  const filtered = computed(() =>
    filterTree(source.value, query.value, getSearchText),
  );

  /**
   * Which set is live is decided on read, so there is no moment where the items
   * and the expansion come from different queries: both are this one computed
   * away from the same string.
   */
  const expanded = computed({
    get: () =>
      query.value
        ? (explorer.searchExpanded[tree] ?? filtered.value.expanded)
        : explorer.browseExpanded[tree],
    set: (keys: string[]) => explorer.setExpanded(tree, keys),
  });

  // Search, click a result, clear the field — and without this the row that was
  // just opened is back under branches nobody expanded, so the tree appears to
  // have lost it.
  watch(query, (next, previous) => {
    if (next || !previous || !selected.value) return;
    explorer.reveal(tree, ancestorKeys(source.value, selected.value.key));
  });

  const branches = computed(() => branchKeys(filtered.value.items));

  const allExpanded = computed(
    () =>
      branches.value.length > 0 &&
      branches.value.every((key) => expanded.value.includes(key)),
  );

  /**
   * Open everything, or close it.
   *
   * Written through the same setter as any other toggle, so during a search it
   * lands in the search's own set and the expansion the user built is still
   * waiting when the query goes.
   */
  function toggleAll() {
    explorer.setExpanded(tree, allExpanded.value ? [] : branches.value);
  }

  return {
    query,
    items: computed(() => filtered.value.items),
    expanded,
    isEmpty: computed(() => !!query.value && filtered.value.items.length === 0),
    hasBranches: computed(() => branches.value.length > 0),
    allExpanded,
    toggleAll,
  };
}
