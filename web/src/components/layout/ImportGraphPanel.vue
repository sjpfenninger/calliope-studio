<script setup lang="ts">
/**
 * ImportGraphPanel — a Dialog that renders the YAML import graph as a DAG.
 *
 * Uses @vue-flow/core for graph rendering. Nodes are YAML files in the
 * version; edges represent `import:` relationships. The root file
 * (model.yaml) is rendered with a distinct style.
 *
 * On node click: opens the file in the editor.
 */
import { ref, computed, watch } from "vue";
import Dialog from "primevue/dialog";
import Button from "primevue/button";
import { VueFlow, type Node, type Edge, Position } from "@vue-flow/core";
import client from "../../api/client";
import { useEditorStore } from "../../stores/editor";

const props = defineProps<{
  versionId: string;
  visible: boolean;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();

const editorStore = useEditorStore();

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
      `/api/versions/${props.versionId}/import-graph/`
    );
    graphData.value = res.data;
  } catch {
    error.value = "Failed to load import graph.";
  } finally {
    isLoading.value = false;
  }
}

watch(() => props.visible, (v) => {
  if (v && !graphData.value) load();
});

// ---------------------------------------------------------------------------
// Convert graph data to Vue Flow nodes + edges with a simple horizontal layout
// ---------------------------------------------------------------------------

const HORIZONTAL_SPACING = 220;
const VERTICAL_SPACING = 70;

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
    style: n.type === "root"
      ? { background: "var(--p-primary-100, #e0e7ff)", border: "1.5px solid var(--p-primary-color, #6366f1)", borderRadius: "6px", padding: "6px 12px", fontSize: "0.8rem", fontFamily: "monospace" }
      : { background: "var(--p-surface-0, #fff)", border: "1px solid var(--p-content-border-color, #ccc)", borderRadius: "6px", padding: "6px 12px", fontSize: "0.8rem", fontFamily: "monospace" },
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
  if (!graphData.value) return { nodes: [], edges: [] };
  return computeLayout(graphData.value.nodes, graphData.value.edges);
});

function onNodeClick(event: { node: Node }) {
  const file = event.node.id;
  editorStore.openTab(file, "yaml");
  emit("update:visible", false);
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="Import Graph"
    :style="{ width: '80vw', height: '70vh' }"
    @update:visible="emit('update:visible', $event)"
  >
    <template #header>
      <div class="dialog-header">
        <span class="dialog-title">Import Graph</span>
        <Button
          icon="pi pi-refresh"
          size="small"
          text
          severity="secondary"
          title="Reload"
          :loading="isLoading"
          @click="load"
        />
      </div>
    </template>

    <div class="graph-wrapper">
      <div v-if="isLoading" class="graph-placeholder">Loading…</div>
      <div v-else-if="error" class="graph-placeholder error">{{ error }}</div>
      <div v-else-if="flowGraph.nodes.length === 0" class="graph-placeholder">
        No import relationships found.
      </div>
      <VueFlow
        v-else
        :nodes="flowGraph.nodes"
        :edges="flowGraph.edges"
        :nodes-connectable="false"
        :nodes-draggable="true"
        fit-view-on-init
        class="graph-flow"
        @node-click="onNodeClick"
      />
    </div>
  </Dialog>
</template>

<style scoped>
.dialog-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}

.dialog-title {
  font-weight: 600;
  flex: 1;
}

.graph-wrapper {
  width: 100%;
  height: 100%;
  min-height: 400px;
}

.graph-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--p-text-muted-color, #888);
  font-size: 0.875rem;
}

.graph-placeholder.error {
  color: #ef4444;
}

.graph-flow {
  width: 100%;
  height: 100%;
}
</style>
