import { describe, expect, it } from "vitest";
import type { ImportGraph, ImportGraphNodeType } from "@/api/versions";
import {
  HORIZONTAL_SPACING,
  VERTICAL_SPACING,
  computeLayout,
  edgeStyle,
  isOpenable,
  nodeStyle,
  swatchStyle,
} from "./importGraph";

function graph(
  nodes: [string, ImportGraphNodeType][],
  edges: [string, string, "import" | "math" | "data_table"][] = [],
): ImportGraph {
  return {
    nodes: nodes.map(([id, type]) => ({ id, label: id, type })),
    edges: edges.map(([source, target, kind]) => ({ source, target, kind })),
  };
}

describe("computeLayout", () => {
  it("puts a child one column to the right of its parent", () => {
    const { nodes } = computeLayout(
      graph(
        [
          ["model.yaml", "root"],
          ["techs.yaml", "file"],
        ],
        [["model.yaml", "techs.yaml", "import"]],
      ),
    );
    const [root, child] = nodes;
    expect(child.x - root.x).toBe(HORIZONTAL_SPACING);
  });

  it("takes the longest path when a file is reached two ways", () => {
    // `a → b → c` and `a → c`. Placing `c` beside `b` would draw an edge
    // backwards through the column it came from.
    const { nodes } = computeLayout(
      graph(
        [
          ["a", "root"],
          ["b", "file"],
          ["c", "file"],
        ],
        [
          ["a", "b", "import"],
          ["b", "c", "import"],
          ["a", "c", "import"],
        ],
      ),
    );
    const x = Object.fromEntries(nodes.map((n) => [n.id, n.x]));
    expect(x.c).toBe(2 * HORIZONTAL_SPACING);
  });

  it("centres a column on its parent rather than stacking downwards", () => {
    // A model.yaml naming twenty CSVs beside a column of one reads as a corner
    // if every column starts at y=0. The fan-out is the ordinary case, not the
    // pathological one.
    const leaves: [string, ImportGraphNodeType][] = Array.from(
      { length: 20 },
      (_, i) => [`data_tables/t${i}.csv`, "data_table"],
    );
    const { nodes } = computeLayout(
      graph(
        [["model.yaml", "root"], ...leaves],
        leaves.map(([id]) => ["model.yaml", id, "data_table"]),
      ),
    );
    const ys = nodes.filter((n) => n.type === "data_table").map((n) => n.y);
    expect(Math.min(...ys)).toBe(-9.5 * VERTICAL_SPACING);
    expect(Math.max(...ys)).toBe(9.5 * VERTICAL_SPACING);
    expect(nodes[0].y).toBe(0);
  });

  it("terminates on a cycle rather than hanging", () => {
    // No longer acyclic by construction: nothing stops `a.yaml` naming `b.yaml`
    // in `math_paths` while `b.yaml` imports `a.yaml`. Kahn's loop stalls, and
    // whatever it never reached takes column 0.
    const { nodes } = computeLayout(
      graph(
        [
          ["a.yaml", "root"],
          ["b.yaml", "math"],
        ],
        [
          ["a.yaml", "b.yaml", "math"],
          ["b.yaml", "a.yaml", "import"],
        ],
      ),
    );
    expect(nodes.map((n) => n.x)).toEqual([0, 0]);
  });

  it("drops an edge naming a node that is not there", () => {
    // It would otherwise throw inside a computed, which blanks the dialog —
    // losing the whole graph rather than one line.
    const { nodes, edges } = computeLayout(
      graph([["a.yaml", "root"]], [["a.yaml", "ghost.yaml", "import"]]),
    );
    expect(edges).toEqual([]);
    expect(nodes).toHaveLength(1);
  });
});

describe("styling", () => {
  const kinds: ImportGraphNodeType[] = [
    "root",
    "file",
    "math",
    "data_table",
    "missing",
  ];

  it("gives every kind a look of its own", () => {
    // Two kinds drawn identically is a legend that lies about the graph.
    const drawn = kinds.map((kind) => JSON.stringify(nodeStyle(kind)));
    expect(new Set(drawn).size).toBe(kinds.length);
  });

  it("writes no literal colour", () => {
    // The token layer is the only place a colour may be spelled out, and these
    // strings reach the DOM as inline style where no stylesheet can correct them.
    for (const kind of kinds) {
      const style = { ...nodeStyle(kind), ...swatchStyle(kind) };
      for (const value of Object.values(style)) {
        expect(String(value)).not.toMatch(/#[0-9a-f]{3}|rgb|oklch|\bhsl/i);
      }
    }
  });

  it("keeps the swatch and the node in step", () => {
    // The legend is drawn from the same treatment table, so it cannot come to
    // describe a graph that no longer looks like it.
    for (const kind of kinds) {
      expect(swatchStyle(kind).background).toBe(nodeStyle(kind).background);
      expect(swatchStyle(kind).border).toBe(nodeStyle(kind).border);
    }
  });

  it("dashes what is not there, and only that", () => {
    // The dash used to mark data tables too, which put math and CSV — the one
    // pair a reader actually has to compare — one dash apart at 12px.
    expect(nodeStyle("missing").border).toContain("dashed");
    for (const kind of ["root", "file", "math", "data_table"] as const) {
      expect(nodeStyle(kind).border).toContain("solid");
    }
    expect(edgeStyle("missing").strokeDasharray).toBeTruthy();
    expect(edgeStyle("data_table").strokeDasharray).toBeUndefined();
  });

  it("colours a math node, and the line into it", () => {
    // The whole point of the violet: a custom-math file is the one node that
    // changes what the optimisation *is*, and it has to be findable at a glance.
    expect(nodeStyle("math").color).toBe("var(--cg-math-text)");
    expect(nodeStyle("math").background).toBe("var(--cg-math-soft)");
    expect(edgeStyle("math").stroke).toBe("var(--cg-math-border)");
    expect(edgeStyle("file").stroke).not.toBe(edgeStyle("math").stroke);
  });

  it("says a missing node opens nothing", () => {
    // `openFile` on a path that is not there opens a tab that 404s.
    expect(isOpenable({ id: "missing:/x", label: "x", type: "missing" })).toBe(false);
    expect(nodeStyle("missing").cursor).toBe("default");
    expect(isOpenable({ id: "a.yaml", label: "a.yaml", type: "file" })).toBe(true);
  });
});
