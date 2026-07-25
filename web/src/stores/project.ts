import { ref } from "vue";
import { defineStore } from "pinia";
import client from "../api/client";

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
}

export const useProjectStore = defineStore("project", () => {
  const currentProject = ref<Project | null>(null);

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

  return { currentProject, loadProject, clearProject };
});
