import { ref } from "vue";
import { defineStore } from "pinia";
import client from "../api/client";

export interface Project {
  id: string;
  name: string;
  /** The model folder's absolute path. */
  description: string;
  /** When it was last opened, not when it was created. */
  created_at: string;
}

export const useProjectStore = defineStore("project", () => {
  const currentProject = ref<Project | null>(null);

  /**
   * The recents list.
   *
   * Here rather than in each component that shows it: the sidebar switcher and
   * the Recent models page render the same list, and the switcher used to fetch
   * its own copy once on mount and never again — so a model created from the
   * sidebar did not appear in the very dropdown the button sat next to.
   */
  const models = ref<Project[]>([]);
  const modelsError = ref<string | null>(null);

  async function loadProject(projectId: string): Promise<void> {
    if (currentProject.value?.id === projectId) return;
    try {
      const res = await client.get<Project>(`/api/projects/${projectId}/`);
      currentProject.value = res.data;
    } catch {
      currentProject.value = null;
    }
  }

  function clearProject(): void {
    currentProject.value = null;
  }

  async function loadModels(): Promise<void> {
    try {
      models.value = (await client.get<Project[]>("/api/projects/")).data;
      modelsError.value = null;
    } catch {
      modelsError.value = "The list of models could not be read.";
    }
  }

  /** Removes a model from the recents list. Nothing on disk is touched. */
  async function forgetModel(projectId: string): Promise<void> {
    await client.delete(`/api/projects/${projectId}/`);
    models.value = models.value.filter((model) => model.id !== projectId);
  }

  return {
    currentProject,
    models,
    modelsError,
    loadProject,
    clearProject,
    loadModels,
    forgetModel,
  };
});
