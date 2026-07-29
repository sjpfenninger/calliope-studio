import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * What each explorer tree is filtered to, and which of its branches are open.
 *
 * In a store rather than in the sections, for the reason the project states in
 * general and one specific to these two: `ModelSection` and `FilesSection` are
 * lazily-mounted route components with no `<keep-alive>` around them, so a local
 * `ref` dies every time the user goes to Files and back. Expansion has always
 * been thrown away that way — it lived inside Reka — and putting it here fixes
 * that as a side effect of needing to control it at all.
 *
 * Nothing here is persisted to `localStorage`. A filter that is still applied
 * the next time the app opens hides most of a model with nothing on screen to
 * blame it on, which is a different thing from the theme and the splitter
 * geometry a user *wants* remembered.
 */

/** The two explorer trees. */
export type ExplorerTree = "model" | "files";

export const useExplorerStore = defineStore("explorer", () => {
  const query = ref<Record<ExplorerTree, string>>({ model: "", files: "" });

  /** The user's own expansion, which a search must leave exactly as it found it. */
  const browseExpanded = ref<Record<ExplorerTree, string[]>>({ model: [], files: [] });

  /**
   * Expansion while a query is live: `null` means "whatever reveals the
   * matches", and a value means the user has since opened or closed something.
   */
  const searchExpanded = ref<Record<ExplorerTree, string[] | null>>({
    model: null,
    files: null,
  });

  function setQuery(tree: ExplorerTree, next: string) {
    query.value[tree] = next;
    // Dropped here rather than from a watcher on the query: a watcher runs after
    // the flush, so for one frame the new results would be drawn against the
    // previous query's expansion — which reads as the tree opening branches that
    // have nothing to do with what was typed.
    searchExpanded.value[tree] = null;
  }

  /**
   * Where Reka's own expand and collapse land.
   *
   * Routing them by whether a query is live is what makes the restore free:
   * during a search nothing touches `browseExpanded`, so clearing the field
   * hands back the tree the user built, with no save-and-restore step to get
   * out of step with Reka.
   */
  function setExpanded(tree: ExplorerTree, keys: string[]) {
    if (query.value[tree]) searchExpanded.value[tree] = keys;
    else browseExpanded.value[tree] = keys;
  }

  /** Open branches for real — what a search owes the row the user chose from it. */
  function reveal(tree: ExplorerTree, keys: string[]) {
    if (!keys.length) return;
    browseExpanded.value[tree] = [...new Set([...browseExpanded.value[tree], ...keys])];
  }

  return { query, browseExpanded, searchExpanded, setQuery, setExpanded, reveal };
});
