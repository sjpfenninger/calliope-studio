/**
 * The named arrangements of the results view's three figures.
 *
 * The results view used to have exactly one geometry — a split per panel count
 * and a collapsed flag per figure — and reka rewrites the split on every drag
 * *and* on every collapse-driven redistribution. So collapsing the totals to
 * concentrate on the map destroyed the sizes of the three-open arrangement, and
 * expanding it again never brought them back: reka hands the slack wherever it
 * likes. Switching figures on and off meant re-dragging the boundaries every
 * time.
 *
 * A layout is therefore a *complete* description of the arrangement — direction,
 * sizes, and which figures are folded to their title bar — and each one owns its
 * own copy. Switching between them disturbs nothing, which is the whole point.
 *
 * Pure and table-driven, deliberately: the store persists a `ResultsGeometry` and
 * the component binds one, and neither of them should have an opinion about what
 * "the map layout" means.
 */
import {
  ChartColumn,
  ChartLine,
  Columns2,
  Map as MapIcon,
  Rows3,
  type LucideIcon,
} from "@lucide/vue";

/** The three figures, which are also the three collapsible panels. */
export type ResultsFigure = "map" | "timeseries" | "static";

export const RESULTS_FIGURES: ResultsFigure[] = ["map", "timeseries", "static"];

/**
 * The two splitter groups.
 *
 * `main` divides the map from the charts; `charts` divides the time series from
 * the totals. There are always exactly two panels in each, whichever layout is
 * showing — see `ResultsLayout.direction` for why that is enough to express both
 * a stack and a side-by-side, and why the panel count no longer varies with the
 * model.
 */
export type ResultsGroup = "main" | "charts";

export const RESULTS_GROUPS: ResultsGroup[] = ["main", "charts"];

export type ResultsLayoutId = "stacked" | "beside" | "map" | "timeseries" | "totals";

/** One layout's mutable state: what the user has dragged and folded away. */
export interface ResultsGeometry {
  sizes: Record<ResultsGroup, number[]>;
  collapsed: Record<ResultsFigure, boolean>;
}

export interface ResultsLayout {
  id: ResultsLayoutId;
  /** Shown in the strip, and the whole explanation: these name themselves. */
  label: string;
  icon: LucideIcon;
  /**
   * Which way the `main` group runs.
   *
   * The one thing that separates a stack from a side-by-side, and it is a prop
   * rather than a second panel tree: reka reads `direction` reactively and panel
   * sizes are percentages, so flipping it rearranges the same mounted panels.
   * Two `v-if` trees would tear down MapLibre and both ECharts instances on
   * every switch, and the map would lose the viewport the user had panned to.
   *
   * It also decides whether the map may be folded to its title bar: a
   * horizontally collapsed card cannot show a horizontal title bar, so in
   * `beside` the map has no disclosure and the outer handle is what moves. To
   * put the map away there, pick another layout — which is what they are for.
   */
  direction: "vertical" | "horizontal";
  /** Not offered for a model with no geography, since it turns on the map. */
  needsMap: boolean;
  /** Where the panels sit before the user has dragged anything. */
  geometry: ResultsGeometry;
}

function geometry(
  sizes: Record<ResultsGroup, number[]>,
  collapsed: Partial<Record<ResultsFigure, boolean>> = {},
): ResultsGeometry {
  return {
    sizes,
    collapsed: {
      map: collapsed.map ?? false,
      timeseries: collapsed.timeseries ?? false,
      static: collapsed.static ?? false,
    },
  };
}

/**
 * The layouts, in the order the strip shows them.
 *
 * The focus layouts (`map`, `timeseries`, `totals`) carry sizes as well as
 * collapsed flags even though a collapsed panel is pinned to its own measured
 * title bar and so overrides them: the sizes are what the *open* panels land on
 * the first time, before the user has dragged anything.
 */
export const RESULTS_LAYOUTS: ResultsLayout[] = [
  {
    id: "stacked",
    label: "Stacked",
    icon: Rows3,
    direction: "vertical",
    needsMap: false,
    geometry: geometry({ main: [34, 66], charts: [61, 39] }),
  },
  {
    id: "beside",
    label: "Beside",
    icon: Columns2,
    direction: "horizontal",
    needsMap: true,
    geometry: geometry({ main: [52, 48], charts: [58, 42] }),
  },
  {
    id: "map",
    label: "Map",
    icon: MapIcon,
    direction: "vertical",
    needsMap: true,
    // Not more than this to the map: what is left has to hold the time series
    // *and* the folded totals, and a chart under about 250px is an axis with a
    // zoom slider under it.
    geometry: geometry({ main: [62, 38], charts: [70, 30] }, { static: true }),
  },
  {
    id: "timeseries",
    label: "Time series",
    icon: ChartLine,
    direction: "vertical",
    needsMap: false,
    geometry: geometry(
      { main: [12, 88], charts: [88, 12] },
      { map: true, static: true },
    ),
  },
  {
    id: "totals",
    label: "Totals",
    icon: ChartColumn,
    direction: "vertical",
    needsMap: false,
    geometry: geometry(
      { main: [12, 88], charts: [12, 88] },
      { map: true, timeseries: true },
    ),
  },
];

export const RESULTS_LAYOUT_IDS = RESULTS_LAYOUTS.map((layout) => layout.id);

export const DEFAULT_RESULTS_LAYOUT: ResultsLayoutId = "stacked";

export function findLayout(id: ResultsLayoutId): ResultsLayout {
  return (
    RESULTS_LAYOUTS.find((layout) => layout.id === id) ??
    RESULTS_LAYOUTS[0]
  );
}

export function isLayoutId(value: unknown): value is ResultsLayoutId {
  return (
    typeof value === "string" &&
    RESULTS_LAYOUT_IDS.includes(value as ResultsLayoutId)
  );
}

/** A fresh copy of a layout's defaults, safe to mutate. */
export function defaultGeometry(id: ResultsLayoutId): ResultsGeometry {
  const source = findLayout(id).geometry;
  return {
    sizes: { main: [...source.sizes.main], charts: [...source.sizes.charts] },
    collapsed: { ...source.collapsed },
  };
}

export function defaultGeometries(): Record<ResultsLayoutId, ResultsGeometry> {
  return Object.fromEntries(
    RESULTS_LAYOUT_IDS.map((id) => [id, defaultGeometry(id)]),
  ) as Record<ResultsLayoutId, ResultsGeometry>;
}

/**
 * Whether a stored value is a geometry this view can bind.
 *
 * As strict as the per-count length check it replaces, and for the same reason:
 * a group handed an array of the wrong length leaves a panel with no size at
 * all, and reka's answer to that is a redistribution the user never asked for.
 * A hand-edited or stale entry falls back to its layout's defaults rather than
 * being repaired, since there is no honest way to guess what was meant.
 */
export function isGeometry(value: unknown): value is ResultsGeometry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as ResultsGeometry;
  const sizes = candidate.sizes as unknown;
  if (!sizes || typeof sizes !== "object") return false;
  for (const group of RESULTS_GROUPS) {
    const entry = (sizes as Record<string, unknown>)[group];
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    if (!entry.every((size) => typeof size === "number" && Number.isFinite(size))) {
      return false;
    }
  }
  const collapsed = candidate.collapsed as unknown;
  if (!collapsed || typeof collapsed !== "object") return false;
  return RESULTS_FIGURES.every(
    (figure) => typeof (collapsed as Record<string, unknown>)[figure] === "boolean",
  );
}

export function sameGeometry(a: ResultsGeometry, b: ResultsGeometry): boolean {
  const sizesMatch = RESULTS_GROUPS.every((group) =>
    a.sizes[group].every(
      // Rounded: reka emits fractional percentages that differ from the stated
      // default by less than a pixel, and a reset button that lights up because
      // the splitter re-emitted its own defaults is noise.
      (size, index) => Math.round(size) === Math.round(b.sizes[group][index] ?? NaN),
    ),
  );
  const collapsedMatch = RESULTS_FIGURES.every(
    (figure) => a.collapsed[figure] === b.collapsed[figure],
  );
  return sizesMatch && collapsedMatch;
}
