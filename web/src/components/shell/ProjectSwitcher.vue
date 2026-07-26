<script setup lang="ts">
/**
 * Which model is open, and how to open another.
 *
 * Sits at the top of the sidebar rather than in a breadcrumb: the sidebar is
 * project-scoped, so the thing it is scoped *to* belongs at its head. The
 * previous menubar showed the same information as a breadcrumb with no way to
 * switch, which meant changing model went through the browser's back button.
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { Check, ChevronsUpDown, FolderOpen } from "lucide-vue-next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import client from "@/api/client";
import { ICON_STROKE_WIDTH } from "@/lib/icons";

const props = defineProps<{
  currentId: string | null;
  currentName: string | null;
}>();

interface Project {
  id: string;
  name: string;
  description: string;
}

const router = useRouter();
const projects = ref<Project[]>([]);

onMounted(async () => {
  try {
    projects.value = (await client.get<Project[]>("/api/projects/")).data;
  } catch {
    projects.value = [];
  }
});

function open(id: string) {
  if (id === props.currentId) return;
  // Through the resolver, which finds the project's version and replaces —
  // a project id alone is not enough to address the shell.
  router.push({ name: "project", params: { projectId: id } });
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger
      data-testid="project-switcher"
      class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm transition-colors hover:bg-hover"
    >
      <FolderOpen
        class="size-3.5 shrink-0 text-text-faint"
        :stroke-width="ICON_STROKE_WIDTH"
      />
      <span class="min-w-0 flex-1 truncate font-medium">
        {{ currentName ?? "No model open" }}
      </span>
      <ChevronsUpDown class="size-3 shrink-0 text-text-faint" :stroke-width="2" />
    </DropdownMenuTrigger>

    <DropdownMenuContent align="start" class="w-64">
      <DropdownMenuItem
        v-for="project in projects"
        :key="project.id"
        class="gap-2"
        @select="open(project.id)"
      >
        <Check
          class="size-3.5 shrink-0"
          :class="project.id === currentId ? 'opacity-100' : 'opacity-0'"
          :stroke-width="2.5"
        />
        <span class="min-w-0 flex-1">
          <span class="block truncate">{{ project.name }}</span>
          <span class="block truncate text-2xs text-text-faint">
            {{ project.description }}
          </span>
        </span>
      </DropdownMenuItem>

      <DropdownMenuSeparator v-if="projects.length" />
      <DropdownMenuItem @select="router.push({ name: 'projects' })">
        Recent models…
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
