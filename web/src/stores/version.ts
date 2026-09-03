import { ref } from "vue";
import { defineStore } from "pinia";
import { errorDetail } from "../api/errors";
import { listFiles } from "../api/versions";
import { buildFileTree, type FileEntry, type FileTreeNode } from "../lib/fileTree";

export type { FileEntry, FileTreeNode };

export const useVersionStore = defineStore("version", () => {
  const fileTree = ref<FileTreeNode[]>([]);
  /**
   * The flat listing the tree was built from.
   *
   * Kept rather than discarded because `size` was already being fetched and
   * thrown away: the binary viewer says how big the file it will not display
   * is, and that costs no extra request.
   */
  const files = ref<FileEntry[]>([]);
  const currentVersionId = ref<string | null>(null);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  /**
   * The model's files.
   *
   * The `catch` is not decoration. This is called from a watcher in
   * `FilesSection`, so without it a failed listing left the tree at whatever it
   * held and threw an unhandled rejection out of a reactive effect — the one
   * shape of failure that reaches no `try` anywhere. Its three sibling stores
   * (`componentTree`, `templates`, `schemaKinds`) all catch; this one did not.
   *
   * Empty rather than stale, and `error` rather than silence: a model whose
   * files cannot be listed must not look like a model with no files.
   *
   * Every assignment is behind the same check that `stores/schemaKinds.ts`
   * makes: a listing for the model the user has just left arriving after the
   * one they are now looking at used to win, leaving the file tree showing
   * another model's files under this model's id — and `isLoading` was cleared
   * by whichever call finished first rather than by the one that matters.
   */
  async function loadFileTree(versionId: string): Promise<void> {
    currentVersionId.value = versionId;
    isLoading.value = true;
    error.value = null;
    try {
      const listing = await listFiles(versionId);
      if (currentVersionId.value !== versionId) return;
      files.value = listing;
      fileTree.value = buildFileTree(listing);
    } catch (caught) {
      if (currentVersionId.value !== versionId) return;
      files.value = [];
      fileTree.value = [];
      error.value = errorDetail(caught, "Could not list this model's files.");
    } finally {
      if (currentVersionId.value === versionId) isLoading.value = false;
    }
  }

  /** A file's size in bytes, or null if it is not in the current listing. */
  function sizeOf(path: string): number | null {
    return files.value.find((entry) => entry.path === path)?.size ?? null;
  }

  return {
    fileTree,
    files,
    currentVersionId,
    isLoading,
    error,
    loadFileTree,
    sizeOf,
  };
});
