<script setup lang="ts">
/**
 * The application shell: a sidebar, and a tab area.
 *
 * One route record serves all three sections, with `Model`, `Files` and `Runs`
 * as children rendering into the sidebar's body. That is the whole reason for
 * the nesting: switching section does not remount the shell, so the tab bar,
 * Monaco's text models and any live run pane survive navigation for free.
 *
 * Two orthogonal things live in the URL. The path says which model version and
 * which section; `?tab=` says which tab is in front. They are independent — a
 * YAML tab can be in front while the Runs section is showing — so they get
 * independent slots, and the tab is written with `replace` so that opening and
 * closing tabs does not fill the back button.
 */
import { computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import AppSidebar from "./AppSidebar.vue";
import TabBar from "./TabBar.vue";
import TabBody from "./TabBody.vue";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { initMonacoYaml } from "@/monacoSetup";
import { useProjectStore } from "@/stores/project";
import { useTabsStore } from "@/stores/tabs";
import { useUiStore } from "@/stores/ui";

const route = useRoute();
const router = useRouter();
const tabs = useTabsStore();
const project = useProjectStore();
const ui = useUiStore();

const projectId = computed(() => (route.params.projectId as string) ?? null);
const versionId = computed(() => (route.params.versionId as string) ?? null);

onMounted(() => {
  initMonacoYaml();
});

watch(
  [projectId, versionId],
  ([nextProject, nextVersion]) => {
    if (nextProject) project.loadProject(nextProject);
    if (nextVersion) tabs.setVersion(nextVersion);
  },
  { immediate: true },
);

// Store → URL. `replace`, not `push`: switching tab is not navigation, and
// filling the back button with it would make the button useless.
watch(
  () => tabs.activeId,
  (id) => {
    const tab = id ?? undefined;
    if (route.query.tab !== tab) {
      router.replace({ query: { ...route.query, tab } });
    }
  },
);

// URL → store, for a cold link or a back/forward. An id that cannot be parsed
// is ignored rather than fatal: a URL outlives the scheme that wrote it.
watch(
  () => route.query.tab,
  (raw) => {
    const id = typeof raw === "string" ? raw : null;
    if (!id || id === tabs.activeId) return;
    if (tabs.has(id)) tabs.activate(id);
    else tabs.openFromId(id);
  },
  { immediate: true },
);

function onLayout(sizes: number[]) {
  ui.setSplitterSizes(sizes);
}
</script>

<template>
  <ResizablePanelGroup
    direction="horizontal"
    class="min-h-0 flex-1"
    @layout="onLayout"
  >
    <ResizablePanel :default-size="22" :min-size="14" :max-size="40">
      <AppSidebar :project-id="projectId" :version-id="versionId" />
    </ResizablePanel>

    <ResizableHandle />

    <ResizablePanel :default-size="78">
      <div class="flex h-full min-h-0 flex-col">
        <TabBar />
        <TabBody />
      </div>
    </ResizablePanel>
  </ResizablePanelGroup>
</template>
