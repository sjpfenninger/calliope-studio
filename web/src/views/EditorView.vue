<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute } from "vue-router";
import { initMonacoYaml } from "../monacoSetup";
import Splitter from "primevue/splitter";
import SplitterPanel from "primevue/splitterpanel";
import ExplorerPanel from "../components/layout/ExplorerPanel.vue";
import EditorPanel from "../components/layout/EditorPanel.vue";
import SidePanel from "../components/layout/SidePanel.vue";
import { useVersionStore } from "../stores/version";
import { useEditorStore } from "../stores/editor";
import { useProjectStore } from "../stores/project";

const route = useRoute();
const versionStore = useVersionStore();
const editorStore = useEditorStore();
const projectStore = useProjectStore();

const STORAGE_KEY = "calliope.splitter.sizes";
const DEFAULT_SIZES = [20, 55, 25];

const sizes = ref<number[]>(
  (() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? (JSON.parse(stored) as number[]) : DEFAULT_SIZES;
    } catch {
      return DEFAULT_SIZES;
    }
  })(),
);

function onResizeEnd(event: { sizes: number[] }) {
  sizes.value = event.sizes;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(event.sizes));
}

onMounted(() => {
  const projectId = route.params.id as string;
  const versionId = route.params.versionId as string;
  projectStore.loadProject(projectId);
  editorStore.setVersion(versionId);
  versionStore.loadFileTree(versionId);
  initMonacoYaml();
});
</script>

<template>
  <div class="editor-view">
    <Splitter class="editor-splitter" @resizeend="onResizeEnd">
      <SplitterPanel :size="sizes[0]" :min-size="10">
        <ExplorerPanel />
      </SplitterPanel>
      <SplitterPanel :size="sizes[1]" :min-size="20">
        <EditorPanel />
      </SplitterPanel>
      <SplitterPanel :size="sizes[2]" :min-size="10">
        <SidePanel />
      </SplitterPanel>
    </Splitter>
  </div>
</template>

<style scoped>
.editor-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.editor-splitter {
  flex: 1;
  height: 100%;
}

/* Make each SplitterPanel fill its height so child components can use 100% height. */
:deep(.p-splitter-panel) {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
