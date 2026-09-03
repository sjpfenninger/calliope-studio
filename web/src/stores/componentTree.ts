import { ref } from "vue";
import { defineStore } from "pinia";
import { errorDetail } from "../api/errors";
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
  const error = ref<string | null>(null);
  const loadedVersionId = ref<string | null>(null);

  /**
   * Which model the most recent call asked about.
   *
   * The guard `stores/schemaKinds.ts` already uses, and for the same failure:
   * a reply for model A landing after the user has moved to B was assigned
   * regardless, and `loadedVersionId` was then set to A — so the early return
   * at the top of `load` saw a tree it believed was B's and never refetched.
   * The model column showed another model's technologies until a manual
   * refresh. `isLoading` is cleared only by the latest call for the same
   * reason: the first of two overlapping loads used to clear the spinner while
   * the one that matters was still in flight.
   */
  let requested: string | null = null;

  async function load(versionId: string): Promise<void> {
    // Recorded before the early return, not after it: asking for a model that
    // is already loaded is still a statement about which one is wanted, and
    // without it a request still in flight for the *previous* model would land
    // and replace the cached tree the caller just asked for.
    requested = versionId;
    if (loadedVersionId.value === versionId && tree.value !== null) return;
    isLoading.value = true;
    error.value = null;
    try {
      const loaded = await getComponentTree(versionId);
      if (requested !== versionId) return;
      tree.value = loaded;
      loadedVersionId.value = versionId;
    } catch (caught) {
      if (requested !== versionId) return;
      tree.value = null;
      loadedVersionId.value = null;
      error.value = errorDetail(caught, "Could not read this model's structure.");
    } finally {
      if (requested === versionId) isLoading.value = false;
    }
  }

  async function refresh(versionId: string): Promise<void> {
    loadedVersionId.value = null;
    await load(versionId);
  }

  return { tree, isLoading, error, load, refresh };
});
