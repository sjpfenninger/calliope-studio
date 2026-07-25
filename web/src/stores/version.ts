import { ref } from "vue";
import { defineStore } from "pinia";
import client from "../api/client";

export interface FileEntry {
  path: string;
  type: "yaml" | "csv" | "other";
  size: number;
}

export interface TreeNode {
  key: string;
  label: string;
  type: "yaml" | "csv" | "other" | "directory";
  leaf: boolean;
  fileIcon: string;
  children?: TreeNode[];
}

function fileIcon(type: FileEntry["type"]): string {
  if (type === "yaml") return "pi pi-file-edit";
  if (type === "csv") return "pi pi-table";
  return "pi pi-file";
}

function buildTree(entries: FileEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirs: Record<string, TreeNode> = {};

  function ensureDir(parts: string[]): TreeNode[] {
    if (parts.length === 0) return root;
    const key = parts.join("/");
    if (!dirs[key]) {
      const parentChildren = ensureDir(parts.slice(0, -1));
      const node: TreeNode = {
        key,
        label: parts[parts.length - 1],
        type: "directory",
        leaf: false,
        fileIcon: "pi pi-folder",
        children: [],
      };
      parentChildren.push(node);
      dirs[key] = node;
    }
    return dirs[key].children!;
  }

  for (const entry of entries) {
    const parts = entry.path.split("/");
    const dirParts = parts.slice(0, -1);
    const fileName = parts[parts.length - 1];
    const parentChildren = ensureDir(dirParts);
    parentChildren.push({
      key: entry.path,
      label: fileName,
      type: entry.type,
      leaf: true,
      fileIcon: fileIcon(entry.type),
    });
  }

  return root;
}

export const useVersionStore = defineStore("version", () => {
  const fileTree = ref<TreeNode[]>([]);
  const currentVersionId = ref<string | null>(null);
  const isLoading = ref(false);

  async function loadFileTree(versionId: string): Promise<void> {
    currentVersionId.value = versionId;
    isLoading.value = true;
    try {
      const res = await client.get<FileEntry[]>(`/api/versions/${versionId}/files/`);
      fileTree.value = buildTree(res.data);
    } finally {
      isLoading.value = false;
    }
  }

  return { fileTree, currentVersionId, isLoading, loadFileTree };
});
