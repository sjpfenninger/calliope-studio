<script setup lang="ts">
/**
 * The left column: which model, which section, and the section's own contents.
 *
 * The section body is a `<RouterView>` — that is what makes Model, Files and Runs
 * real routes rather than a local `ref`, which is what they used to be.
 */
import { computed } from "vue";
import PanelFooter from "@/components/app/PanelFooter.vue";

import ProjectSwitcher from "./ProjectSwitcher.vue";
import SidebarNav from "./SidebarNav.vue";
import ThemeToggle from "@/components/layout/ThemeToggle.vue";
import { useProjectStore } from "@/stores/project";

const props = defineProps<{
  projectId: string | null;
  versionId: string | null;
}>();

const project = useProjectStore();

/** A bare results file has no model definition, so two sections are unavailable. */
const editable = computed(() => props.versionId !== null);
</script>

<template>
  <!-- No border of its own: the splitter handle beside it draws the hairline, and
       two rules on one boundary is a 2px seam where every other bar is 1px. -->
  <aside class="flex h-full min-h-0 flex-col bg-panel">
    <div class="shrink-0 border-b border-border p-1.5">
      <ProjectSwitcher
        :current-id="projectId"
        :current-name="project.currentProject?.name ?? null"
      />
    </div>

    <SidebarNav
      :project-id="projectId"
      :version-id="versionId"
      :editable="editable"
      class="shrink-0 border-b border-border"
    />

    <div class="flex min-h-0 flex-1 flex-col">
      <RouterView />
    </div>

    <PanelFooter class="justify-end">
      <ThemeToggle />
    </PanelFooter>
  </aside>
</template>
