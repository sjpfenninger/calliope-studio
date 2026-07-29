<script setup lang="ts">
/**
 * The model's `import:` graph, as a DAG.
 *
 * A Calliope model is spread over as many files as its author likes, and the
 * only statement of how they fit together is a chain of `import:` lists. This is
 * that chain, drawn: nodes are YAML files, edges are imports, the entry point is
 * marked, and clicking a node opens it.
 *
 * Laid out by hand rather than with a layout library — a topological sort into
 * columns is all an import graph needs, and it has no cycles by construction.
 */
import { ref, computed, watch } from "vue";
import StateMessage from "@/components/app/StateMessage.vue";
import InfoTip from "@/components/app/InfoTip.vue";
import { RefreshCw } from "@lucide/vue";
import { VueFlow, type Node, type Edge, Position } from "@vue-flow/core";

import client from "@/api/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ICON_BUTTON } from "@/lib/formClasses";

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

interface GraphData {
  nodes: Array<{ id: string; label: string; type: string }>;
  edges: Array<{ source: string; target: string }>;
}

const graphData = ref<GraphData | null>(null);
const isLoading = ref(false);
const error = ref<string | null>(null);

async function load() {
  if (!props.versionId) return;
  isLoading.value = true;
  error.value = null;
  try {
    const res = await client.get<GraphData>(
      `/api/versions/${props.versionId}/import-graph/`,
    );
    graphData.value = res.data;
  } catch {
    error.value = "Failed to load import graph.";
  } finally {
    isLoading.value = false;
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v && !graphData.value) load();
  },
);

// ---------------------------------------------------------------------------
// Convert graph data to Vue Flow nodes + edges with a simple horizontal layout
// ---------------------------------------------------------------------------

const HORIZONTAL_SPACING = 220;
const VERTICAL_SPACING = 70;

/**
 * Node styling, from the design tokens.
 *
 * Vue Flow renders in the DOM, so unlike the canvas renderers it can read
 * `var(--cg-*)` directly — but these are inline styles, so they are computed
 * fresh when the theme's revision changes rather than being re-resolved by the
 * cascade.
 */
function nodeStyle(isRoot: boolean) {
  return {
    background: isRoot ? "var(--cg-accent-soft)" : "var(--cg-surface)",
    border: `1px solid ${isRoot ? "var(--cg-accent-border)" : "var(--cg-border)"}`,
    color: isRoot ? "var(--cg-accent-text)" : "var(--cg-text)",
    borderRadius: "var(--cg-radius-sm)",
    padding: "4px 10px",
    fontSize: "12px",
    fontFamily: "var(--cg-font-mono)",
    // Vue Flow's default node has a fixed width, which truncates every path
    // longer than about twenty characters — which is most of them.
    width: "auto",
    whiteSpace: "nowrap",
  };
}

function computeLayout(
  rawNodes: GraphData["nodes"],
  rawEdges: GraphData["edges"],
): { nodes: Node[]; edges: Edge[] } {
  // Topological sort to assign columns (depths) and rows (order within depth).
  const inDegree: Record<string, number> = {};
  const adj: Record<string, string[]> = {};
  for (const n of rawNodes) {
    inDegree[n.id] = 0;
    adj[n.id] = [];
  }
  for (const e of rawEdges) {
    adj[e.source].push(e.target);
    inDegree[e.target] = (inDegree[e.target] ?? 0) + 1;
  }

  const depth: Record<string, number> = {};
  const queue: string[] = rawNodes.filter((n) => inDegree[n.id] === 0).map((n) => n.id);
  for (const id of queue) depth[id] = 0;
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    for (const child of adj[id]) {
      depth[child] = Math.max(depth[child] ?? 0, depth[id] + 1);
      inDegree[child]--;
      if (inDegree[child] === 0) queue.push(child);
    }
  }
  // Assign unvisited nodes depth 0
  for (const n of rawNodes) {
    if (depth[n.id] === undefined) depth[n.id] = 0;
  }

  const byDepth: Record<number, string[]> = {};
  for (const [id, d] of Object.entries(depth)) {
    (byDepth[d] = byDepth[d] ?? []).push(id);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  for (const [dStr, ids] of Object.entries(byDepth)) {
    const d = Number(dStr);
    ids.forEach((id, i) => {
      positions[id] = {
        x: d * HORIZONTAL_SPACING,
        y: i * VERTICAL_SPACING,
      };
    });
  }

  const nodes: Node[] = rawNodes.map((n) => ({
    id: n.id,
    label: n.label,
    position: positions[n.id] ?? { x: 0, y: 0 },
    type: "default",
    style: nodeStyle(n.type === "root"),
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  }));

  const edges: Edge[] = rawEdges.map((e, i) => ({
    id: `e${i}`,
    source: e.source,
    target: e.target,
    type: "smoothstep",
  }));

  return { nodes, edges };
}

const flowGraph = computed(() => {
  // Depending on the revision as well as the data: the node styles are inline,
  // so a theme change has to rebuild them.
  void ui.revision;
  if (!graphData.value) return { nodes: [], edges: [] };
  return computeLayout(graphData.value.nodes, graphData.value.edges);
});

function onNodeClick(event: { node: Node }) {
  // A single click, like the tree's: previews rather than piling up a tab.
  tabsStore.openFile(event.node.id, { preview: true });
  emit("update:visible", false);
}
</script>

<template>
  <Dialog :open="visible" @update:open="emit('update:visible', $event)">
    <DialogContent
      class="flex h-[70vh] max-w-[80vw] flex-col"
      data-testid="import-graph"
    >
      <DialogHeader>
        <div class="flex items-center gap-2">
          <DialogTitle class="flex-1">Import graph</DialogTitle>
          <!-- Not a `TooltipButton`: the spin belongs to the glyph, and putting
               it on the button would rotate the hover square with it. -->
          <InfoTip label="Reload">
            <button
              type="button"
              aria-label="Reload"
              :class="ICON_BUTTON"
              @click="load"
            >
              <RefreshCw
                class="size-3.5"
                :class="isLoading ? 'animate-spin' : ''"
              />
            </button>
          </InfoTip>
        </div>
        <DialogDescription>
          Every file the model pulls in, and what pulls it in. Click one to open it.
        </DialogDescription>
      </DialogHeader>

      <div class="min-h-0 flex-1 rounded-sm border border-border bg-surface">
        <StateMessage v-if="isLoading" variant="fill" loading>
          Loading…
        </StateMessage>
        <StateMessage v-else-if="error" variant="fill" tone="danger">
          {{ error }}
        </StateMessage>
        <StateMessage v-else-if="!flowGraph.nodes.length" variant="fill">
          No import relationships found.
        </StateMessage>
        <VueFlow
          v-else
          :nodes="flowGraph.nodes"
          :edges="flowGraph.edges"
          :nodes-connectable="false"
          :nodes-draggable="true"
          fit-view-on-init
          class="size-full"
          @node-click="onNodeClick"
        />
      </div>
    </DialogContent>
  </Dialog>
</template>
