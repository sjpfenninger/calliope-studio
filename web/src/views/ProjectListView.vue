<script setup lang="ts">
/**
 * Recent models.
 *
 * This was "Projects", a grid of cards showing a name and a creation date, with
 * a disabled "New project" button and no way to add or remove anything. But a
 * local workspace is a folder, and the honest presentation of a list of folders
 * is a list of paths: which folder, when it was last opened, which one this
 * server is serving right now, and how to stop it being listed.
 *
 * "Removed" means removed from this list. The folder, the model and its runs are
 * the user's own files, and until now the only way an entry could leave was for
 * the folder to be deleted from disk.
 */
import { computed, onMounted, ref } from "vue";
import Panel from "@/components/app/Panel.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import { PRIMARY_BUTTON } from "@/lib/formClasses";
import { cn } from "@/lib/utils";
import { useRouter } from "vue-router";
import { FolderOpen, FolderPlus, X } from "@lucide/vue";

import client from "@/api/client";
import OpenModelDialog from "@/components/workspace/OpenModelDialog.vue";
import { formatRelativeTime, formatTimestamp } from "@/lib/format";

import { useProjectStore, type Project } from "@/stores/project";

const router = useRouter();
const projectStore = useProjectStore();

const models = ref<Project[]>([]);
const isLoading = ref(true);
const error = ref<string | null>(null);
const registryPath = ref<string | null>(null);
const currentId = ref<string | null>(null);
const browsing = ref(false);

const hasModels = computed(() => models.value.length > 0);

async function load() {
  try {
    models.value = (await client.get<Project[]>("/api/projects/")).data;
    error.value = null;
  } catch {
    error.value = "The list of models could not be read.";
  } finally {
    isLoading.value = false;
  }
}

onMounted(async () => {
  // Leaving the shell means no model is current any more; the switcher in the
  // sidebar reads this.
  projectStore.clearProject();
  await load();
  try {
    const health = (await client.get("/api/health")).data;
    registryPath.value = health.registry_path ?? null;
    currentId.value = health.workspace_id ?? null;
  } catch {
    registryPath.value = null;
  }
});

function open(id: string) {
  // Through the resolver: a project id alone cannot address the shell, which
  // needs a version too.
  router.push({ name: "project", params: { projectId: id } });
}

async function forget(id: string) {
  await client.delete(`/api/projects/${id}/`);
  models.value = models.value.filter((model) => model.id !== id);
}
</script>

<template>
  <div class="mx-auto flex h-full w-full max-w-3xl min-h-0 flex-col p-6">
    <header class="mb-3 flex shrink-0 items-center gap-2">
      <h1 class="text-lg font-semibold">Recent models</h1>
      <div class="flex-1" />
      <button
        type="button"
        data-testid="open-model"
        :class="cn(PRIMARY_BUTTON, 'h-7 px-2.5')"
        @click="browsing = true"
      >
        <FolderPlus class="size-3.5" />
        Open model…
      </button>
    </header>

    <StateMessage v-if="isLoading" variant="inline" loading>Reading the model list…</StateMessage>
    <StateMessage v-else-if="error" variant="inline" tone="danger">{{ error }}</StateMessage>

    <!-- The empty state lives *inside* this box rather than replacing it, so the
         list does not vanish when there is nothing in it yet. -->
    <Panel
      v-else
      data-testid="recent-models"
      class="min-h-0 overflow-y-auto"
    >
      <div
        v-for="model in models"
        :key="model.id"
        class="group flex h-8 items-center gap-2 border-b border-border-subtle px-2 last:border-b-0 hover:bg-hover"
        data-testid="recent-model"
      >
        <FolderOpen
          class="size-3.5 shrink-0 text-text-faint"
        />

        <button
          type="button"
          class="min-w-0 flex-1 text-left"
          data-testid="recent-model-open"
          @click="open(model.id)"
        >
          <span class="flex items-center gap-1.5">
            <span class="truncate text-sm font-medium">{{ model.name }}</span>
            <span
              v-if="model.id === currentId"
              class="shrink-0 rounded-xs border border-accent-border bg-accent-soft px-1 text-2xs text-accent-text"
            >
              Open now
            </span>
          </span>
          <!-- The full path, not the folder name: two models called `model` in
               different places are otherwise indistinguishable. -->
          <span class="block truncate font-mono text-xs text-text-faint">
            {{ model.description }}
          </span>
        </button>

        <span
          class="shrink-0 text-2xs text-text-faint"
          :title="formatTimestamp(model.created_at)"
        >
          {{ formatRelativeTime(model.created_at) }}
        </span>

        <button
          type="button"
          data-testid="forget-model"
          title="Remove from this list (nothing is deleted)"
          class="grid size-5 shrink-0 place-items-center rounded-xs text-text-faint opacity-0 group-hover:opacity-100 hover:bg-active hover:text-foreground focus-visible:opacity-100"
          @click="forget(model.id)"
        >
          <X class="size-3.5" />
        </button>
      </div>

      <StateMessage v-if="!hasModels" variant="block" title="No models yet">
        Open a folder containing a <code class="font-mono">model.yaml</code>, or
        start Calliope Studio with one:
        <code class="mt-1 block font-mono text-xs">calliope-studio path/to/model</code>
      </StateMessage>
    </Panel>

    <div class="flex-1" />

    <p class="mt-2 shrink-0 text-2xs text-text-faint">
      This list is kept in
      <code class="font-mono">{{ registryPath ?? "the Calliope Studio state directory" }}</code
      >. Removing a model here does not delete anything on disk.
    </p>

    <OpenModelDialog v-model:open="browsing" @opened="open" />
  </div>
</template>
