<script setup lang="ts">
/**
 * Every file the model reads, as a DAG.
 *
 * A Calliope model is spread over as many files as its author likes, and it
 * names them three ways: `import:` chains, `config.init.math_paths`, and the
 * CSVs behind `data_tables[*].table`. Only the first is a chain the graph could
 * follow on its own, so all three come from the server — which reads them with
 * the same walk a run snapshot is frozen from. Clicking a node opens it.
 *
 * Laid out by hand rather than with a layout library — a topological sort into
 * columns is all this needs. `lib/importGraph.ts` has it, and the styling.
 */
import { ref, computed, watch } from "vue";
import StateMessage from "@/components/app/StateMessage.vue";
import PanelFooter from "@/components/app/PanelFooter.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import { RefreshCw, X } from "@lucide/vue";
import {
  VueFlow,
  useVueFlow,
  type Node,
  type Edge,
  type NodeMouseEvent,
  Position,
} from "@vue-flow/core";

import { errorDetail } from "@/api/errors";
import { getImportGraph, type ImportGraph } from "@/api/versions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  LEGEND,
  computeLayout,
  edgeStyle,
  isOpenable,
  nodeStyle,
  swatchStyle,
} from "@/lib/importGraph";
import { openIntent } from "@/lib/openIntent";

import { useTabsStore } from "@/stores/tabs";
import { useUiStore } from "@/stores/ui";

const props = defineProps<{
  versionId: string;
  visible: boolean;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();

const tabsStore = useTabsStore();
const ui = useUiStore();

const { fitView } = useVueFlow();

/**
 * Fitted by hand rather than with `fit-view-on-init`, for the two bounds.
 *
 * `maxZoom: 1` because a five-file model would otherwise be scaled up until its
 * labels were half again the size of every other label in the app — fitting is
 * meant to bring a big graph into view, not to magnify a small one. And a
 * `minZoom` under the store's default 0.5, because one file naming twenty CSVs
 * is a 1300px column: clamped at 0.5 the graph is silently cut off, with no
 * scrollbar and nothing on screen to say there is more.
 */
const MIN_ZOOM = 0.15;

function fit() {
  void fitView({ maxZoom: 1, padding: 0.1 });
}

const graphData = ref<ImportGraph | null>(null);
const isLoading = ref(false);
const error = ref<string | null>(null);

async function load() {
  if (!props.versionId) return;
  isLoading.value = true;
  error.value = null;
  try {
    graphData.value = await getImportGraph(props.versionId);
  } catch (caught) {
    error.value = errorDetail(caught, "The import graph could not be read.");
  } finally {
    isLoading.value = false;
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v && !graphData.value) void load();
  },
);

// The graph is one model's files and nothing about it carries over. Dropped
// rather than reloaded: this only ever fetches on open, so reopening on the new
// model is what asks again — and a dialog that is not showing has no business
// making a request.
watch(
  () => props.versionId,
  () => {
    graphData.value = null;
    error.value = null;
    if (props.visible) void load();
  },
);

const flowGraph = computed<{ nodes: Node[]; edges: Edge[] }>(() => {
  // Depending on the revision as well as the data: the node styles are inline,
  // so a theme change has to rebuild them.
  void ui.revision;
  if (!graphData.value) return { nodes: [], edges: [] };
  const layout = computeLayout(graphData.value);
  const typeOf = new Map(layout.nodes.map((node) => [node.id, node.type]));
  return {
    nodes: layout.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      position: { x: node.x, y: node.y },
      type: "default",
      style: nodeStyle(node.type),
      data: { reason: node.reason, openable: isOpenable(node) },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    })),
    edges: layout.edges.map((edge, i) => ({
      id: `e${i}`,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      style: edgeStyle(typeOf.get(edge.target) ?? "file"),
    })),
  };
});

/** Only the kinds actually present, so a healthy model says nothing about missing files. */
const legend = computed(() => {
  const present = new Set(graphData.value?.nodes.map((node) => node.type));
  return LEGEND.filter((item) => present.has(item.type));
});

function onNodeClick({ event, node }: NodeMouseEvent) {
  // Nothing to open: `openFile` on a path that is not there opens a tab that
  // 404s, which is a worse answer than the node's own styling already gives.
  if (!node.data?.openable) return;
  // The tree's rule, not a rule of its own: a plain click previews, a modifier
  // or a double-click keeps the tab. A touch carries no modifier and previews.
  const intent = event instanceof MouseEvent ? openIntent(event) : { preview: true };
  tabsStore.openFile(node.id, intent);
  emit("update:visible", false);
}
</script>

<template>
  <Dialog :open="visible" @update:open="emit('update:visible', $event)">
    <!-- `sm:max-w-[80vw]`, because `DialogContent`'s own base caps at
         `sm:max-w-lg` and an unprefixed override loses to it at every width that
         matters: the 80vw this asked for has never been what it got. A graph of
         every file the model reads needs the room more than a chain of four did. -->
    <DialogContent
      class="flex h-[70vh] flex-col sm:max-w-[80vw]"
      data-testid="import-graph"
      :show-close-button="false"
    >
      <DialogHeader>
        <!-- Both buttons in the row, which is why the content's own absolutely
             positioned close is turned off: it lands in exactly this corner. -->
        <div class="flex items-center gap-1">
          <DialogTitle class="flex-1">Import graph</DialogTitle>
          <!-- No spinning glyph: the body already says it is reading, and a
               second signal for one state is what a dead button looks like. -->
          <TooltipButton
            label="Reload the import graph"
            :icon="RefreshCw"
            :disabled="isLoading"
            @click="load"
          />
          <TooltipButton
            label="Close"
            :icon="X"
            testid="import-graph-close"
            @click="emit('update:visible', false)"
          />
        </div>
        <DialogDescription>Click a file to open it.</DialogDescription>
      </DialogHeader>

      <div
        class="flex min-h-0 flex-1 flex-col rounded-md border border-border bg-surface"
      >
        <StateMessage v-if="isLoading" variant="fill" loading>
          Reading the import graph…
        </StateMessage>
        <StateMessage v-else-if="error" variant="fill" tone="danger">
          {{ error }}
        </StateMessage>
        <StateMessage v-else-if="!flowGraph.nodes.length" variant="fill">
          No files found.
        </StateMessage>
        <template v-else>
          <VueFlow
            :nodes="flowGraph.nodes"
            :edges="flowGraph.edges"
            :nodes-connectable="false"
            :nodes-draggable="true"
            :min-zoom="MIN_ZOOM"
            class="min-h-0 flex-1"
            @nodes-initialized="fit"
            @node-click="onNodeClick"
          />
          <!-- The treatments are deliberately quiet, so nothing else on screen
               says what a dashed border means. -->
          <PanelFooter>
            <span class="flex items-center gap-3">
              <span
                v-for="item in legend"
                :key="item.type"
                class="flex items-center gap-1"
              >
                <span class="size-2.5 shrink-0" :style="swatchStyle(item.type)" />
                {{ item.label }}
              </span>
            </span>
          </PanelFooter>
        </template>
      </div>
    </DialogContent>
  </Dialog>
</template>
