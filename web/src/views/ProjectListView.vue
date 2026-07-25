<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import Card from "primevue/card";
import Button from "primevue/button";
import client from "../api/client";
import { useProjectStore } from "../stores/project";

const router = useRouter();
const projectStore = useProjectStore();

interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
}

interface Version {
  id: string;
  label: string;
  created_at: string;
}

const projects = ref<Project[]>([]);
const isLoading = ref(true);
const error = ref<string | null>(null);

onMounted(async () => {
  projectStore.clearProject();
  try {
    const res = await client.get<Project[]>("/api/projects/");
    projects.value = res.data;
  } catch {
    error.value = "Failed to load projects.";
  } finally {
    isLoading.value = false;
  }
});

async function openProject(projectId: string) {
  const res = await client.get<Version[]>(`/api/projects/${projectId}/versions/`);
  const versions = res.data;
  if (versions.length === 0) return;
  router.push(`/projects/${projectId}/versions/${versions[0].id}`);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}
</script>

<template>
  <div class="project-list">
    <header class="project-list-header">
      <h1>Projects</h1>
      <Button label="New project" icon="pi pi-plus" disabled />
    </header>
    <div v-if="isLoading" class="status-msg">Loading…</div>
    <div v-else-if="error" class="status-msg error">{{ error }}</div>
    <div v-else-if="projects.length === 0" class="status-msg">
      No projects yet. Use the management command to create one.
    </div>
    <div v-else class="project-grid">
      <Card
        v-for="project in projects"
        :key="project.id"
        class="project-card"
        @click="openProject(project.id)"
      >
        <template #title>{{ project.name }}</template>
        <template #subtitle>Created {{ formatDate(project.created_at) }}</template>
        <template #content>
          <p>{{ project.description }}</p>
        </template>
      </Card>
    </div>
  </div>
</template>

<style scoped>
.project-list {
  padding: 2rem;
  height: 100%;
  overflow-y: auto;
}

.project-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.project-list-header h1 {
  margin: 0;
}

.status-msg {
  text-align: center;
  color: var(--p-text-muted-color, #888);
  margin-top: 3rem;
}

.status-msg.error {
  color: var(--p-red-500, #ef4444);
}

.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.project-card {
  cursor: pointer;
  transition: box-shadow 0.15s ease;
}

.project-card:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}
</style>
