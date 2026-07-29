/**
 * Narrowing an explorer tree to what a query matches.
 *
 * One implementation for both trees, because they differ only in depth — the
 * model tree is two levels of named entries, the file tree is a directory
 * structure of any depth — while "keep the branches a match needs, open the
 * ones hiding it" is the same problem in both. It is also exactly the kind of
 * recursion that is quietly wrong for one shape of input, which is why it is
 * pure and tested rather than living inside a `<script setup>` block twice.
 *
 * The *matched text* is the one thing that genuinely differs, so it is a
 * parameter. A model entry's key is `techs:ccgt`, where matching the key would
 * let `s:c` hit a real row; its label is what the user can see. A file's label
 * is only the last path segment, and a file tree is worth narrowing by path, so
 * that one is matched against the whole thing.
 */

/** What both explorer node types already are: keyed, optionally branching. */
export interface TreeNodeLike<T> {
  key: string;
  children?: T[];
}

export interface FilteredTree<T> {
  items: T[];
  /** Branch keys that must be open for every match to be on screen. */
  expanded: string[];
}

export function filterTree<T extends TreeNodeLike<T>>(
  items: T[],
  query: string,
  getSearchText: (item: T) => string,
): FilteredTree<T> {
  const needle = query.trim().toLowerCase();

  // Returned by identity, not rebuilt: an explorer is unfiltered almost all of
  // the time, and handing Reka a fresh array on every render would cost it the
  // row reuse for nothing.
  if (!needle) return { items, expanded: [] };

  const expanded: string[] = [];

  function visit(node: T): T | null {
    const children = node.children;

    if (getSearchText(node).toLowerCase().includes(needle)) {
      // A match is kept whole, as the original object: typing a section or a
      // folder name means "show me that", so its contents have to come with it.
      // Recursion stops here, so only the matched branch opens — descending
      // would turn one hit on `data_tables` into every file under it.
      if (children?.length) expanded.push(node.key);
      return node;
    }

    const kept = (children ?? [])
      .map(visit)
      .filter((child): child is T => child !== null);
    if (!kept.length) return null;

    expanded.push(node.key);
    // Reka reads `children` for truthiness, not length, so an empty array gives
    // a leaf a chevron and a branch that opens onto nothing. A node is only
    // rebuilt when it has survivors to carry.
    return { ...node, children: kept } as T;
  }

  return {
    items: items.map(visit).filter((item): item is T => item !== null),
    expanded,
  };
}

/**
 * Every key that can be opened: the nodes that have children, at any depth.
 *
 * What "expand all" opens, and what deciding whether everything already is open
 * compares against. Both have to be answered about the tree *as filtered*, since
 * that is the one on screen — a button reporting "collapse all" because of
 * folders a query has hidden would be describing something the user cannot see.
 */
export function branchKeys<T extends TreeNodeLike<T>>(items: T[]): string[] {
  return items.flatMap((item) =>
    item.children?.length ? [item.key, ...branchKeys(item.children)] : [],
  );
}

/**
 * The keys on the path down to `key`, excluding it; `[]` if it is not there.
 *
 * What a search has to hand back when it ends: a row reached by filtering sits
 * under branches the user never opened, so clearing the query would hide the
 * one thing they had just picked.
 */
export function ancestorKeys<T extends TreeNodeLike<T>>(
  items: T[],
  key: string,
): string[] {
  function walk(nodes: T[], trail: string[]): string[] | null {
    for (const node of nodes) {
      if (node.key === key) return trail;
      const found = node.children?.length ? walk(node.children, [...trail, node.key]) : null;
      if (found) return found;
    }
    return null;
  }

  return walk(items, []) ?? [];
}
