/**
 * The import graph's layout and node styling, apart from the dialog that draws it.
 *
 * Pure, because it is the interesting half: five node kinds with a precedence
 * between them, a fan-out that a model with twenty data tables reaches easily,
 * and a topological sort that must terminate on input it can no longer assume is
 * acyclic. None of that needs a browser to be wrong in.
 */
import type { CSSProperties } from "vue";
import type {
  ImportGraph,
  ImportGraphEdge,
  ImportGraphNode,
  ImportGraphNodeType,
} from "@/api/versions";

export const HORIZONTAL_SPACING = 220;
export const VERTICAL_SPACING = 70;

interface Treatment {
  background: string;
  border: string;
  color: string;
  dashed: boolean;
}

/**
 * Two hues and a ramp, and the dash means one thing only.
 *
 * The entry point takes the accent and a math file takes the violet, because
 * those are the two nodes a reader is looking *for*: one is where Calliope
 * starts, the other changes what the optimisation is. Everything else is on the
 * achromatic ramp and is told apart by fill — an imported YAML file sits on
 * `surface`, so it reads as an outline against the pane, while a CSV is a
 * filled grey box on `surface-2`.
 *
 * Dashed is reserved for `missing`. It used to mark data tables as well, which
 * put the only two treatments a reader has to compare — math against CSV — one
 * dash apart at 12px, and that is not a difference anybody sees.
 */
const TREATMENTS: Record<ImportGraphNodeType, Treatment> = {
  root: {
    background: "var(--cg-accent-soft)",
    border: "var(--cg-accent-border)",
    color: "var(--cg-accent-text)",
    dashed: false,
  },
  file: {
    background: "var(--cg-surface)",
    border: "var(--cg-border)",
    color: "var(--cg-text)",
    dashed: false,
  },
  math: {
    background: "var(--cg-math-soft)",
    border: "var(--cg-math-border)",
    color: "var(--cg-math-text)",
    dashed: false,
  },
  data_table: {
    background: "var(--cg-surface-2)",
    border: "var(--cg-border)",
    color: "var(--cg-text-dim)",
    dashed: false,
  },
  missing: {
    background: "var(--cg-surface)",
    border: "var(--cg-border-strong)",
    color: "var(--cg-text-faint)",
    dashed: true,
  },
};

/** Whether clicking the node can open anything. */
export function isOpenable(node: ImportGraphNode): boolean {
  return node.type !== "missing";
}

/**
 * Node styling, from the design tokens.
 *
 * Vue Flow renders in the DOM, so unlike the canvas renderers it can read
 * `var(--cg-*)` directly — but these are inline styles, so they are computed
 * fresh when the theme's revision changes rather than being re-resolved by the
 * cascade.
 */
export function nodeStyle(type: ImportGraphNodeType) {
  const treatment = TREATMENTS[type];
  return {
    background: treatment.background,
    border: `1px ${treatment.dashed ? "dashed" : "solid"} ${treatment.border}`,
    color: treatment.color,
    borderRadius: "var(--cg-radius-sm)",
    padding: "4px 10px",
    fontSize: "var(--cg-font-size-sm)",
    fontFamily: "var(--cg-font-sans)",
    // Vue Flow's default node has a fixed width, which truncates every path
    // longer than about twenty characters — which is most of them.
    width: "auto",
    whiteSpace: "nowrap",
    cursor: type === "missing" ? "default" : "pointer",
  };
}

/**
 * The legend's swatch: the same treatment, with none of the box.
 *
 * Derived from `TREATMENTS` rather than restated, so the key cannot come to
 * describe a graph that no longer looks like it.
 */
export function swatchStyle(type: ImportGraphNodeType): CSSProperties {
  const treatment = TREATMENTS[type];
  return {
    background: treatment.background,
    border: `1px ${treatment.dashed ? "dashed" : "solid"} ${treatment.border}`,
    borderRadius: "var(--cg-radius-xs)",
  };
}

/**
 * An edge looks like the node it lands on — which is the *target's* type, not
 * the kind of reference that named it: a file both imported and named as math
 * is drawn as math, so the line into it has to agree.
 */
export function edgeStyle(target: ImportGraphNodeType) {
  if (target === "math") return { stroke: "var(--cg-math-border)" };
  if (target === "missing") {
    return { stroke: "var(--cg-border-strong)", strokeDasharray: "4 3" };
  }
  return { stroke: "var(--cg-border-strong)" };
}

export interface PositionedNode extends ImportGraphNode {
  x: number;
  y: number;
}

export interface Layout {
  nodes: PositionedNode[];
  edges: ImportGraphEdge[];
}

/**
 * Columns by longest path from a root, rows centred within each column.
 *
 * Centred rather than top-aligned because the fan-out is real: one `model.yaml`
 * naming twenty CSVs beside a column of two reads as a corner otherwise.
 *
 * The sort no longer has "no cycles by construction" to lean on — `import:`
 * cycles are guarded upstream, but nothing stops `a.yaml` naming `b.yaml` in
 * `math_paths` while `b.yaml` imports `a.yaml`. Kahn's loop stalls rather than
 * looping, and whatever it never reached takes depth 0.
 */
export function computeLayout(graph: ImportGraph): Layout {
  const inDegree: Record<string, number> = {};
  const adjacency: Record<string, string[]> = {};
  for (const node of graph.nodes) {
    inDegree[node.id] = 0;
    adjacency[node.id] = [];
  }

  // An edge naming an id no node declares would otherwise throw inside a
  // computed, which blanks the whole dialog rather than losing one line.
  const edges = graph.edges.filter(
    (edge) => edge.source in adjacency && edge.target in adjacency,
  );
  for (const edge of edges) {
    adjacency[edge.source].push(edge.target);
    inDegree[edge.target] += 1;
  }

  const depth: Record<string, number> = {};
  const queue = graph.nodes.filter((n) => inDegree[n.id] === 0).map((n) => n.id);
  for (const id of queue) depth[id] = 0;
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    for (const child of adjacency[id]) {
      depth[child] = Math.max(depth[child] ?? 0, depth[id] + 1);
      inDegree[child] -= 1;
      if (inDegree[child] === 0) queue.push(child);
    }
  }
  for (const node of graph.nodes) depth[node.id] ??= 0;

  const columns = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const column = columns.get(depth[node.id]) ?? [];
    column.push(node.id);
    columns.set(depth[node.id], column);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  for (const [column, ids] of columns) {
    ids.forEach((id, index) => {
      positions[id] = {
        x: column * HORIZONTAL_SPACING,
        y: (index - (ids.length - 1) / 2) * VERTICAL_SPACING,
      };
    });
  }

  return {
    nodes: graph.nodes.map((node) => ({ ...node, ...positions[node.id] })),
    edges,
  };
}

/** The legend's rows, in the order the eye should read them. */
export const LEGEND: { type: ImportGraphNodeType; label: string }[] = [
  { type: "root", label: "Entry point" },
  { type: "file", label: "Imported" },
  { type: "math", label: "Math" },
  { type: "data_table", label: "Data table" },
  { type: "missing", label: "Missing" },
];
