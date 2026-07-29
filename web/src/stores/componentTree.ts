import { ref } from "vue";
import { defineStore } from "pinia";
import { getComponentTree } from "../api/versions";

// The shapes moved to `api/versions.ts`, where the call that fetches them is.
// Re-exported because half the app imports them from here.
export type {
  ComponentTree,
  ComponentTreeEntry,
  ComponentTreeSection,
} from "../api/versions";
import type { ComponentTree } from "../api/versions";

export const useComponentTreeStore = defineStore("componentTree", () => {
  const tree = ref<ComponentTree | null>(null);
  const isLoading = ref(false);
  const loadedVersionId = ref<string | null>(null);

  async function load(versionId: string): Promise<void> {
    if (loadedVersionId.value === versionId && tree.value !== null) return;
    isLoading.value = true;
    try {
      tree.value = await getComponentTree(versionId);
      loadedVersionId.value = versionId;
    } catch {
      tree.value = null;
    } finally {
      isLoading.value = false;
    }
  }

  async function refresh(versionId: string): Promise<void> {
    loadedVersionId.value = null;
    await load(versionId);
  }

  return { tree, isLoading, load, refresh };
});
