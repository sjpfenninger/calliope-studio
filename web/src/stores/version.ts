import { ref } from "vue";
import { defineStore } from "pinia";
import client from "../api/client";
import { buildFileTree, type FileEntry, type FileTreeNode } from "../lib/fileTree";

export type { FileEntry, FileTreeNode };

export const useVersionStore = defineStore("version", () => {
  const fileTree = ref<FileTreeNode[]>([]);
  const currentVersionId = ref<string | null>(null);
  const isLoading = ref(false);

  async function loadFileTree(versionId: string): Promise<void> {
    currentVersionId.value = versionId;
    isLoading.value = true;
    try {
      const res = await client.get<FileEntry[]>(`/api/versions/${versionId}/files/`);
      fileTree.value = buildFileTree(res.data);
    } finally {
      isLoading.value = false;
    }
  }

  return { fileTree, currentVersionId, isLoading, loadFileTree };
});
