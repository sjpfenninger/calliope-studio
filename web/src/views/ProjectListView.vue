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
 *
 * A row is two lines and sized by them, not pinned to a control height: the name
 * and the path together are 32px of text, which is exactly what an `h-8` row
 * gave them, so the two lines sat on each other and on the row's hairline.
 */
import { computed, onMounted, ref } from "vue";
import Panel from "@/components/app/Panel.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import InfoTip from "@/components/app/InfoTip.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/lib/formClasses";
import { cn } from "@/lib/utils";
import { useRouter } from "vue-router";
import { FolderOpen, FolderPlus, FolderSearch, X } from "@lucide/vue";

import { getHealth } from "@/api/system";
import ModelDialogs from "@/components/workspace/ModelDialogs.vue";
import { formatRelativeTime, formatTimestamp } from "@/lib/format";

import { useProjectStore } from "@/stores/project";

const router = useRouter();
const projectStore = useProjectStore();

const isLoading = ref(true);
const registryPath = ref<string | null>(null);
const currentId = ref<string | null>(null);
const dialog = ref<"open" | "new" | null>(null);

const models = computed(() => projectStore.models);
const hasModels = computed(() => models.value.length > 0);

onMounted(async () => {
  // Leaving the shell means no model is current any more; the switcher in the
  // sidebar reads this.
  projectStore.clearProject();
  await projectStore.loadModels();
  isLoading.value = false;
  try {
    const health = await getHealth();
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
</script>

<template>
  <div class="mx-auto flex h-full w-full max-w-3xl min-h-0 flex-col p-6">
    <header class="mb-3 flex shrink-0 items-center gap-2">
      <h1 class="text-lg font-semibold">Recent models</h1>
      <div class="flex-1" />
      <button
        type="button"
        data-testid="open-model"
        :class="cn(SECONDARY_BUTTON, 'h-7 px-2.5')"
        @click="dialog = 'open'"
      >
        <FolderSearch class="size-3.5" />
        Open model…
      </button>
      <button
        type="button"
        data-testid="new-model"
        :class="cn(PRIMARY_BUTTON, 'h-7 px-2.5')"
        @click="dialog = 'new'"
      >
        <FolderPlus class="size-3.5" />
        New model…
      </button>
    </header>

    <StateMessage v-if="isLoading" variant="inline" loading>Reading the model list…</StateMessage>
    <StateMessage v-else-if="projectStore.modelsError" variant="inline" tone="danger">
      {{ projectStore.modelsError }}
    </StateMessage>

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
        class="group flex min-h-8 items-center gap-2 border-b border-border-subtle px-2 py-1.5 last:border-b-0 hover:bg-hover"
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

        <InfoTip :label="formatTimestamp(model.created_at)">
          <span class="shrink-0 text-2xs text-text-faint">
            {{ formatRelativeTime(model.created_at) }}
          </span>
        </InfoTip>

        <TooltipButton
          label="Remove from this list (nothing is deleted)"
          :icon="X"
          size="sm"
          testid="forget-model"
          class="opacity-0 group-hover:opacity-100 hover:bg-active hover:text-foreground focus-visible:opacity-100"
          @click="projectStore.forgetModel(model.id)"
        />
      </div>

      <!-- design-check: allow native-title — `StateMessage`'s `title` is a prop. -->
      <StateMessage v-if="!hasModels" variant="block" title="No models yet">
        Open a folder containing a <code class="font-mono">model.yaml</code>, or
        start a new one from a Calliope example with <strong>New model…</strong>
      </StateMessage>
    </Panel>

    <div class="flex-1" />

    <p class="mt-2 shrink-0 text-2xs text-text-faint">
      This list is kept in
      <code class="font-mono">{{ registryPath ?? "the Calliope Studio state directory" }}</code
      >. Removing a model here does not delete anything on disk.
    </p>

    <ModelDialogs v-model:open="dialog" @opened="open" />
  </div>
</template>
