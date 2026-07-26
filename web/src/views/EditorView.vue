<script setup lang="ts">
import { computed, onMounted } from "vue";
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
import { useUiStore } from "../stores/ui";

const route = useRoute();
const versionStore = useVersionStore();
const editorStore = useEditorStore();
const projectStore = useProjectStore();
// Panel geometry is UI state, so it belongs in a store rather than in this
// component's own localStorage calls.
const ui = useUiStore();

const sizes = computed(() => ui.splitterSizes);

function onResizeEnd(event: { sizes: number[] }) {
  ui.setSplitterSizes(event.sizes);
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
