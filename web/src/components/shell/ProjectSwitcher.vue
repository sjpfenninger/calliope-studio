<script setup lang="ts">
/**
 * Which model is open, and how to get another one.
 *
 * Sits at the top of the sidebar rather than in a breadcrumb: the sidebar is
 * project-scoped, so the thing it is scoped *to* belongs at its head. The
 * previous menubar showed the same information as a breadcrumb with no way to
 * switch, which meant changing model went through the browser's back button.
 *
 * The two buttons beside it are the other half of the same question. Switching
 * used to be possible only between models already in the recents list — the
 * dropdown had no way to open a folder and no way at all to create one, which
 * meant starting a model meant leaving the app for a terminal.
 *
 * Each entry is two lines, the folder name over its path, because two models
 * called `model` in different places are otherwise indistinguishable. That is
 * why the menu item is `h-auto`: the primitive is a fixed 24px row, which two
 * lines of text overflow, and they used to clip into each other.
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { Check, ChevronsUpDown, FolderOpen, FolderPlus, FolderSearch } from "@lucide/vue";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ModelDialogs from "@/components/workspace/ModelDialogs.vue";
import { shortenPath } from "@/lib/format";
import { ICON_BUTTON } from "@/lib/formClasses";
import { ICON_STROKE_WIDTH_TIGHT } from "@/lib/icons";
import { useProjectStore } from "@/stores/project";

const props = defineProps<{
  currentId: string | null;
  currentName: string | null;
}>();

const router = useRouter();
const projects = useProjectStore();
const dialog = ref<"open" | "new" | null>(null);

onMounted(() => projects.loadModels());

function open(id: string) {
  if (id === props.currentId) return;
  // Through the resolver, which finds the project's version and replaces —
  // a project id alone is not enough to address the shell.
  router.push({ name: "project", params: { projectId: id } });
}

/**
 * A model just opened or created from one of the buttons.
 *
 * The list is reloaded first: the sidebar survives navigation between projects,
 * so without this a model created here would be missing from the very dropdown
 * the button sits next to.
 */
async function opened(id: string) {
  await projects.loadModels();
  open(id);
}
</script>

<template>
  <div class="flex items-center gap-1">
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="project-switcher"
        class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-sm px-2 text-left text-sm transition-colors hover:bg-hover"
      >
        <FolderOpen class="size-3.5 shrink-0 text-text-faint" />
        <span class="min-w-0 flex-1 truncate font-medium">
          {{ currentName ?? "No model open" }}
        </span>
        <ChevronsUpDown
          class="size-3 shrink-0 text-text-faint"
          :stroke-width="ICON_STROKE_WIDTH_TIGHT"
        />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" class="w-80">
        <DropdownMenuItem
          v-for="project in projects.models"
          :key="project.id"
          data-testid="switcher-model"
          class="h-auto gap-2 py-1.5"
          @select="open(project.id)"
        >
          <Check
            class="size-3.5 shrink-0"
            :class="project.id === currentId ? 'opacity-100' : 'opacity-0'"
          />
          <span class="min-w-0 flex-1" :title="project.description">
            <span class="block truncate">{{ project.name }}</span>
            <!-- Shortened from the head: `truncate` clips the end, and the end
                 is the only part that tells two models in one tree apart. -->
            <span class="block truncate font-mono text-xs text-text-faint">
              {{ shortenPath(project.description, 2) }}
            </span>
          </span>
        </DropdownMenuItem>

        <DropdownMenuSeparator v-if="projects.models.length" />
        <DropdownMenuItem @select="router.push({ name: 'projects' })">
          Recent models…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <button
      type="button"
      data-testid="open-model"
      title="Open a model…"
      :class="ICON_BUTTON"
      @click="dialog = 'open'"
    >
      <FolderSearch class="size-3.5" />
    </button>
    <button
      type="button"
      data-testid="new-model"
      title="New model…"
      :class="ICON_BUTTON"
      @click="dialog = 'new'"
    >
      <FolderPlus class="size-3.5" />
    </button>

    <ModelDialogs v-model:open="dialog" @opened="opened" />
  </div>
</template>
