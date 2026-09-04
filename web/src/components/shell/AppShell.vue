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
import { computed, onMounted, onUnmounted, watch } from "vue";
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
import { useCompareStore } from "@/stores/compare";
import { useExplorerStore } from "@/stores/explorer";
import { useMathStore } from "@/stores/math";
import { useProjectStore } from "@/stores/project";
import { useRunsStore } from "@/stores/runs";
import { useSchemaKindsStore } from "@/stores/schemaKinds";
import { useTabsStore } from "@/stores/tabs";
import { useUiStore } from "@/stores/ui";
import { useValidationStore } from "@/stores/validation";

const route = useRoute();
const router = useRouter();
const tabs = useTabsStore();
const project = useProjectStore();
const schemaKinds = useSchemaKindsStore();
const runs = useRunsStore();
const validation = useValidationStore();
const math = useMathStore();
const explorer = useExplorerStore();
const compare = useCompareStore();
const ui = useUiStore();

const projectId = computed(() => (route.params.projectId as string) ?? null);
const versionId = computed(() => (route.params.versionId as string) ?? null);

/**
 * A reload, a closed browser tab or a navigation out of the app discards every
 * unsaved buffer with nothing on disk. The route guard covers moving within
 * the app; this is the browser's own last question, and it is only asked while
 * there is something to lose — a prompt on every reload would be ignored.
 */
function guardUnload(event: BeforeUnloadEvent) {
  if (!tabs.hasDirtyTabs) return;
  event.preventDefault();
  // Older browsers need the legacy property set to show anything at all.
  event.returnValue = "";
}

onMounted(() => {
  initMonacoYaml();
  window.addEventListener("beforeunload", guardUnload);
});

onUnmounted(() => window.removeEventListener("beforeunload", guardUnload));

watch(
  [projectId, versionId],
  ([nextProject, nextVersion], previous) => {
    if (nextProject) project.loadProject(nextProject);
    if (!nextVersion || nextVersion === previous?.[1]) return;

    tabs.setVersion(nextVersion);
    // Everything below is state about the model being left, and this is the one
    // place a model switch is handled. `RunsSection` used to stop the polls and
    // log streams from its own watcher, but it unmounts whenever the user is on
    // Model or Files — so a switch made from either fired that watcher
    // `immediate`, with nothing to compare against, and the old model's runs
    // went on polling into the new model's list.
    runs.stopAll();
    validation.reset();
    // The math tab's own `versionId` watcher resets this too, but only while
    // that tab is mounted — switched away from, the old model's render kept
    // its phase and payload, and the tab bar now shows the phase.
    math.reset();
    explorer.reset();
    // Its keys carry no version id, so a pair both models define would have
    // shown the previous model's diff until the new one arrived — and its
    // poll chains would have gone on asking about the old version.
    compare.reset();
    // Which schema describes which of this model's files. Fetched per model
    // because it depends on the `import:` graph, and before any editor opens so
    // that the first file to be shown is validated against the right one.
    void schemaKinds.load(nextVersion);
    // What this model had open last time. A `?tab=` in the URL wins over it —
    // a link to a specific tab has to beat whatever the last session left
    // behind — which is why `restore` hands the id back instead of activating.
    const remembered = tabs.restore(nextVersion);
    if (remembered && typeof route.query.tab !== "string") tabs.activate(remembered);
  },
  { immediate: true },
);

// Store → localStorage. Ids only; they are enough to rebuild every tab.
watch(
  [() => [...tabs.openTabs.keys()].join("\n"), () => tabs.activeId],
  () => tabs.persist(),
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
    <!-- Read back from the store: the drag below writes it on every frame, and
         for as long as this said `22` nothing ever read it. -->
    <ResizablePanel :default-size="ui.splitterSizes[0]" :min-size="14" :max-size="40">
      <AppSidebar :project-id="projectId" :version-id="versionId" />
    </ResizablePanel>

    <!-- The grip the results view uses, on the one boundary in the shell that
         moves — the hairline alone said nothing about being draggable. Here the
         handle keeps its line, because it *is* the sidebar's edge. -->
    <ResizableHandle with-handle data-testid="shell-split-handle" />

    <ResizablePanel :default-size="ui.splitterSizes[1]">
      <div class="flex h-full min-h-0 flex-col">
        <TabBar />
        <TabBody />
      </div>
    </ResizablePanel>
  </ResizablePanelGroup>
</template>
