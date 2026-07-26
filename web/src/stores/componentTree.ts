import { ref } from "vue";
import { defineStore } from "pinia";
import client from "../api/client";

export interface ComponentTreeEntry {
  name: string;
  file: string;
  template?: string;
  /** Transmission technologies, which the tree presents as links. */
  link_from?: string;
  link_to?: string;
  /** Overrides: how many settings this one makes. */
  setting_count?: number;
  /** Scenarios: which overrides this one composes. */
  overrides?: string[];
}

export interface ComponentTreeSection {
  file?: string;
  entries?: (string | ComponentTreeEntry)[];
}

export interface ComponentTree {
  config?: ComponentTreeSection;
  data_tables?: ComponentTreeSection;
  techs?: ComponentTreeSection;
  nodes?: ComponentTreeSection;
  links?: ComponentTreeSection;
  templates?: ComponentTreeSection;
  overrides?: ComponentTreeSection;
  scenarios?: ComponentTreeSection;
}

export const useComponentTreeStore = defineStore("componentTree", () => {
  const tree = ref<ComponentTree | null>(null);
  const isLoading = ref(false);
  const loadedVersionId = ref<string | null>(null);

  async function load(versionId: string): Promise<void> {
    if (loadedVersionId.value === versionId && tree.value !== null) return;
    isLoading.value = true;
    try {
      const res = await client.get<ComponentTree>(
        `/api/versions/${versionId}/component-tree/`
      );
      tree.value = res.data;
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
