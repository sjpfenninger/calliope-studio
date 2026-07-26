<script setup lang="ts">
import Menubar from "primevue/menubar";
import { useProjectStore } from "../../stores/project";

const projectStore = useProjectStore();
</script>

<template>
  <Menubar class="app-menubar">
    <template #start>
      <RouterLink to="/projects" class="app-title">Calliope</RouterLink>
      <template v-if="projectStore.currentProject">
        <span class="breadcrumb-sep">›</span>
        <RouterLink
          :to="`/projects/${projectStore.currentProject.id}`"
          class="project-crumb"
        >
          <i class="pi pi-folder" />
          {{ projectStore.currentProject.name }}
        </RouterLink>
      </template>
    </template>
    <template #end>
      <RouterLink to="/results" class="nav-link">
        <i class="pi pi-chart-bar" />
        Results
      </RouterLink>
    </template>
  </Menubar>
</template>

<style scoped>
.app-menubar {
  border-radius: 0;
  border-left: none;
  border-right: none;
  border-top: none;
  flex-shrink: 0;
}

.app-title {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--p-text-color);
  text-decoration: none;
}

.nav-link {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.875rem;
  color: var(--p-text-color);
  text-decoration: none;
}

.nav-link:hover,
.nav-link.router-link-active {
  color: var(--p-primary-color);
}

.breadcrumb-sep {
  margin: 0 0.5rem;
  color: var(--p-text-muted-color, #888);
  font-size: 0.9rem;
}

.project-crumb {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.875rem;
  color: var(--p-text-color);
  text-decoration: none;
}

.project-crumb:hover {
  color: var(--p-primary-color);
}

.project-crumb .pi {
  font-size: 0.85rem;
}
</style>
