import { ref } from "vue";
import { defineStore } from "pinia";
import client from "../api/client";
import { errorDetail } from "../api/errors";
import { buildFileTree, type FileEntry, type FileTreeNode } from "../lib/fileTree";

export type { FileEntry, FileTreeNode };

export const useVersionStore = defineStore("version", () => {
  const fileTree = ref<FileTreeNode[]>([]);
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
   */
  async function loadFileTree(versionId: string): Promise<void> {
    currentVersionId.value = versionId;
    isLoading.value = true;
    error.value = null;
    try {
      const res = await client.get<FileEntry[]>(`/api/versions/${versionId}/files/`);
      fileTree.value = buildFileTree(res.data);
    } catch (caught) {
      fileTree.value = [];
      error.value = errorDetail(caught, "Could not list this model's files.");
    } finally {
      isLoading.value = false;
    }
  }

  return { fileTree, currentVersionId, isLoading, error, loadFileTree };
});
