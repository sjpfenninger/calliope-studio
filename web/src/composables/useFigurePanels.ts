/**
 * The results view's panels: sizing, collapsing, and putting a layout on screen.
 *
 * Lifted out of `RunResultsPanel.vue`, where it was inline against a flat group
 * of three panels. Every rule below was paid for by a bug, so the reasoning
 * travels with the code rather than being summarised.
 *
 * The panel tree it drives is **one tree in two directions**:
 *
 *     group "main"  (vertical | horizontal)
 *       ├─ map
 *       └─ group "charts"  (always vertical)
 *            ├─ timeseries
 *            └─ totals
 *
 * `direction` is a prop rather than a second tree because reka reads it
 * reactively and panel sizes are percentages: flipping it rearranges the same
 * mounted panels. Two `v-if` trees would tear down MapLibre and both ECharts
 * instances on every layout switch, and the map would lose the viewport the user
 * panned to.
 *
 * A model with no geography renders the `charts` group as the root and no `main`
 * at all, which is why every group has exactly two panels whatever the model —
 * the per-panel-count bookkeeping the old flat group needed is gone.
 */
import {
  computed,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from "vue";

import {
  RESULTS_FIGURES,
  type ResultsFigure,
  type ResultsGeometry,
  type ResultsGroup,
} from "@/lib/resultsLayouts";

/**
 * What reka exposes on a panel, which `SplitterPanelProps` does not describe.
 *
 * `ResizablePanel` forwards its child's exposed methods through
 * `useForwardExpose`, so these reach `SplitterPanel` — but the wrapper's props
 * type says nothing about them, hence the cast at each ref.
 */
export interface PanelHandle {
  collapse: () => void;
  expand: () => void;
  resize: (size: number) => void;
  /** The panel element, which carries reka's own `data-state`. */
  $el?: HTMLElement;
}

/** A component exposing its root element — every `app/` component does. */
export interface ElementHandle {
  $el?: HTMLElement;
}

export interface PanelBinding {
  order: number;
  defaultSize: number;
  minSize: number;
  maxSize: number;
  collapsedSize?: number;
  collapsible: boolean;
}

export interface FigurePanelsContext {
  /** A figure's panel and header refs, handed over by `FigurePanel`. */
  register(
    figure: ResultsFigure,
    refs: { header: Ref<ElementHandle | null>; panel: Ref<PanelHandle | null> },
  ): void;
  unregister(figure: ResultsFigure): void;
  bindingFor(figure: ResultsFigure): ComputedRef<PanelBinding>;
  /** Whether the figure is showing its contents rather than its title bar. */
  isOpen(figure: ResultsFigure): boolean;
  /** Whether it may be folded away at all — the map cannot be, side by side. */
  isCollapsible(figure: ResultsFigure): boolean;
  /** Why it cannot be folded right now, or "" when it can. */
  lockedReason(figure: ResultsFigure): string;
  toggle(figure: ResultsFigure): void;
  onPanelState(figure: ResultsFigure, collapsed: boolean): void;
}

/** Lets each `FigurePanel` reach the choreography without prop-drilling it. */
export const FIGURE_PANELS = Symbol("figure-panels") as InjectionKey<FigurePanelsContext>;

/**
 * What a panel costs on top of its header: `py-1` above and below the card, plus
 * the card's own hairline top and bottom.
 *
 * Uniform across the figures, which is why they all carry the same padding — a
 * collapsed panel has to be *exactly* its title bar, and it cannot be if each
 * panel wraps its card differently.
 */
const PANEL_CHROME_PX = 8 + 2;

/** A resize handle's own hairline, which is not part of any panel's share. */
const HANDLE_PX = 1;

/** Below this a chart has no plot area left, only insets and a zoom slider. */
const FLOOR_PX = 150;

/**
 * The narrowest either half may be dragged to side by side.
 *
 * Wider than `FLOOR_PX`, because the constraint on this axis is the figure's
 * *chrome*: the map's three variable pickers and the time series' four control
 * groups wrap once below about this, and a header taller than its plot area is
 * not a figure.
 */
const FLOOR_WIDE_PX = 260;

const CHART_FIGURES: ResultsFigure[] = ["timeseries", "static"];

/** Which panel of which group each figure is. */
const SLOT: Record<ResultsFigure, { group: ResultsGroup; order: number }> = {
  map: { group: "main", order: 1 },
  timeseries: { group: "charts", order: 1 },
  static: { group: "charts", order: 2 },
};

interface Options {
  /** Whether the model has geography, and so whether `main` exists at all. */
  hasMap: Ref<boolean>;
  /** Which layout is on screen — see `layoutId` in the sync watch below. */
  layoutId: Ref<string>;
  direction: Ref<"vertical" | "horizontal">;
  /** The current layout's geometry, from the ui store. */
  geometry: Ref<ResultsGeometry>;
  setCollapsed: (figure: ResultsFigure, collapsed: boolean) => void;
  setSizes: (group: ResultsGroup, sizes: number[]) => void;
}

export function useFigurePanels(options: Options) {
  const { hasMap, direction, geometry, layoutId } = options;

  const vertical = computed(() => direction.value === "vertical");

  // ── Registration ──────────────────────────────────────────────────────────

  type Registration = {
    header: Ref<ElementHandle | null>;
    panel: Ref<PanelHandle | null>;
  };

  // A new Map on every change rather than a mutation, so the watches below see
  // it: a figure registers when its panel mounts, and the map's panel mounts a
  // beat after the others because it waits on the geography.
  //
  // `shallowRef`, because `ref` unwraps nested refs — the registrations *are*
  // refs, and deep-unwrapping them would leave nothing to read `.value` from.
  const registry = shallowRef(new Map<ResultsFigure, Registration>());

  function register(figure: ResultsFigure, refs: Registration) {
    const next = new Map(registry.value);
    next.set(figure, refs);
    registry.value = next;
  }

  function unregister(figure: ResultsFigure) {
    const next = new Map(registry.value);
    next.delete(figure);
    registry.value = next;
  }

  function panelOf(figure: ResultsFigure): PanelHandle | null {
    return registry.value.get(figure)?.panel.value ?? null;
  }

  // ── Measurement ───────────────────────────────────────────────────────────

  /** The group elements, measured along the axis each one divides. */
  const mainEl = ref<HTMLElement | null>(null);
  const chartsEl = ref<HTMLElement | null>(null);

  const mainSize = ref(0);
  const chartsSize = ref(0);

  /**
   * Each header's height, measured.
   *
   * Not a constant, which is what made a collapsed figure clip its own title
   * bar: the two chart headers carry enough controls to wrap onto a second row
   * at a narrow width, so "a header is 28px" was true of the map and of neither
   * of the others. What a collapsed panel has to be is *this* header, right now
   * — and side by side, at half the width, they wrap sooner.
   */
  const headerHeights = ref<Record<ResultsFigure, number>>({
    map: 0,
    timeseries: 0,
    static: 0,
  });

  const headerElements = computed(() =>
    RESULTS_FIGURES.map(
      (figure) => registry.value.get(figure)?.header.value?.$el ?? null,
    ),
  );

  function measure() {
    if (mainEl.value) {
      const rect = mainEl.value.getBoundingClientRect();
      mainSize.value = vertical.value ? rect.height : rect.width;
    }
    if (chartsEl.value) {
      chartsSize.value = chartsEl.value.getBoundingClientRect().height;
    }
    const heights = { ...headerHeights.value };
    for (const figure of RESULTS_FIGURES) {
      const element = registry.value.get(figure)?.header.value?.$el;
      if (element) heights[figure] = element.getBoundingClientRect().height;
    }
    headerHeights.value = heights;
  }

  let observer: ResizeObserver | null = null;

  // One observer for both groups and every header: they change together (a
  // window resize reflows the wrapped headers *and* the groups), and a single
  // callback cannot see a half-updated set.
  watch(
    [mainEl, chartsEl, headerElements],
    () => {
      observer?.disconnect();
      observer = null;
      const targets = [mainEl.value, chartsEl.value, ...headerElements.value];
      if (!targets.some(Boolean)) return;
      observer = new ResizeObserver(() => measure());
      for (const target of targets) if (target) observer.observe(target);
      measure();
    },
    { flush: "post" },
  );

  // Flipping the direction does not change the group's box, so the observer
  // never fires — but which of its two dimensions the panels divide has just
  // changed, and every percentage below is computed from it.
  watch(direction, () => measure(), { flush: "post" });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  /**
   * The size the panels of a group actually divide between them.
   *
   * Not the group's own: the resize handles are laid out beside the panels and a
   * panel's percentage is of what is left after them. One pixel each, but a
   * collapsed figure has to be its title bar exactly — a pixel out and the
   * bottom hairline of the strip is the first thing to go.
   */
  const mainAvailable = computed(() => Math.max(0, mainSize.value - HANDLE_PX));
  const chartsAvailable = computed(() => Math.max(0, chartsSize.value - HANDLE_PX));

  function availableFor(figure: ResultsFigure): number {
    return SLOT[figure].group === "main" ? mainAvailable.value : chartsAvailable.value;
  }

  // ── Collapsing ────────────────────────────────────────────────────────────

  /**
   * Whether a figure may be folded to its title bar at all.
   *
   * Vertical only. A horizontally collapsed card would have to show a horizontal
   * title bar, which is not a thing; side by side, the map is put away by
   * choosing another layout instead, and the outer handle still drags.
   */
  function isCollapsible(figure: ResultsFigure): boolean {
    return SLOT[figure].group === "charts" || vertical.value;
  }

  /** What the panel is actually doing, as opposed to what the layout stored. */
  function collapsedNow(figure: ResultsFigure): boolean {
    return geometry.value.collapsed[figure] && isCollapsible(figure);
  }

  function isOpen(figure: ResultsFigure): boolean {
    return !collapsedNow(figure);
  }

  const collapsedPct = computed<Record<ResultsFigure, number>>(() => {
    const of = (figure: ResultsFigure) => {
      const available = availableFor(figure);
      return available > 0 && headerHeights.value[figure] > 0
        ? ((headerHeights.value[figure] + PANEL_CHROME_PX) / available) * 100
        : 5;
    };
    return { map: of("map"), timeseries: of("timeseries"), static: of("static") };
  });

  /**
   * Whether the charts column can shrink to its two title bars.
   *
   * Only when it is a panel of a vertical `main` — that is the one case where
   * something else (the map) can take the height it gives up. As the root group,
   * or as a column beside the map, it has the full height whatever its contents
   * do, and two panels both pinned to a title bar cannot fill it. `lockedReason`
   * is what keeps that state from being reachable.
   */
  const chartsColumnCanShrink = computed(() => hasMap.value && vertical.value);

  const bothChartsCollapsed = computed(() =>
    CHART_FIGURES.every((figure) => collapsedNow(figure)),
  );

  /**
   * The charts column, folded to exactly its two title bars and the rule between
   * them.
   *
   * Pinning the column to this is what makes both charts collapsing consistent:
   * the inner group's available height becomes the sum of the two collapsed
   * sizes, so those two percentages sum to exactly 100 and the splitter has
   * nowhere left to put slack. Without it, collapsing the second chart silently
   * reopened the first.
   */
  const chartsColumnCollapsedPct = computed(() => {
    const px =
      headerHeights.value.timeseries +
      headerHeights.value.static +
      2 * PANEL_CHROME_PX +
      HANDLE_PX;
    const measured =
      headerHeights.value.timeseries > 0 && headerHeights.value.static > 0;
    return mainAvailable.value > 0 && measured
      ? (px / mainAvailable.value) * 100
      : 12;
  });

  /**
   * The smallest a figure may be dragged to before it snaps shut.
   *
   * Always clear of its own collapsed size: reka cannot tell "as small as it
   * goes" from "collapsed" if the two coincide, and a figure that can be dragged
   * to exactly its title bar without registering as collapsed leaves the chevron
   * pointing the wrong way.
   */
  function floorFor(figure: ResultsFigure): number {
    const available = availableFor(figure);
    if (available <= 0) return 15;
    const axisFloor = SLOT[figure].group === "main" && !vertical.value
      ? FLOOR_WIDE_PX
      : FLOOR_PX;
    const floor = (axisFloor / available) * 100;
    return isCollapsible(figure)
      ? Math.max(floor, collapsedPct.value[figure] + 2)
      : Math.min(floor, 45);
  }

  /**
   * A collapsed figure is pinned to its title bar, top and bottom.
   *
   * Collapsing a panel does not make its space disappear — the splitter has to
   * give it to a neighbour, and it will happily give it to a panel that is
   * *itself* collapsed, which silently reopened it. Pinning `minSize` and
   * `maxSize` together leaves the splitter nowhere to put the slack except a
   * figure that is actually open.
   */
  function bindingFor(figure: ResultsFigure): ComputedRef<PanelBinding> {
    return computed(() => {
      const slot = SLOT[figure];
      const sizes = geometry.value.sizes[slot.group];
      const collapsible = isCollapsible(figure);
      const collapsed = collapsedNow(figure);
      return {
        order: slot.order,
        defaultSize: sizes[slot.order - 1],
        minSize: collapsed ? collapsedPct.value[figure] : floorFor(figure),
        maxSize: collapsed ? collapsedPct.value[figure] : 100,
        collapsedSize: collapsible ? collapsedPct.value[figure] : undefined,
        collapsible,
      };
    });
  }

  /** The charts column's own panel, which has no chevron but does get pinned. */
  const chartsColumnBinding = computed<PanelBinding>(() => {
    const pinned = bothChartsCollapsed.value && chartsColumnCanShrink.value;
    const floor =
      mainAvailable.value > 0
        ? ((vertical.value ? FLOOR_PX : FLOOR_WIDE_PX) / mainAvailable.value) * 100
        : 20;
    return {
      order: 2,
      defaultSize: geometry.value.sizes.main[1],
      minSize: pinned ? chartsColumnCollapsedPct.value : Math.min(floor, 45),
      maxSize: pinned ? chartsColumnCollapsedPct.value : 100,
      collapsible: false,
    };
  });

  /** The figures on screen — the map only when there is geography for it. */
  const visibleFigures = computed<ResultsFigure[]>(() =>
    hasMap.value ? RESULTS_FIGURES : CHART_FIGURES,
  );

  /**
   * Why a figure cannot be collapsed, or empty when it can.
   *
   * Two rules, both of them about a group having nowhere to put the slack. The
   * charts column keeps one chart open whenever it cannot shrink — as the root
   * group of a model with no geography, or as a column beside the map. And
   * something, somewhere has to stay open: if every panel were pinned to its
   * title bar there would be a band of space with nothing entitled to it, and
   * one figure would be handed it, showing an empty card under its own title.
   * Keeping one open is also what the feature is for; collapsing everything
   * focuses on nothing.
   */
  function lockedReason(figure: ResultsFigure): string {
    if (collapsedNow(figure)) return "";
    if (SLOT[figure].group === "charts" && !chartsColumnCanShrink.value) {
      const open = CHART_FIGURES.filter((name) => isOpen(name));
      return open.length > 1
        ? ""
        : "Expand the other chart first — one has to stay open.";
    }
    const open = visibleFigures.value.filter((name) => isOpen(name));
    return open.length > 1 ? "" : "Expand another figure first — one has to stay open.";
  }

  function toggle(figure: ResultsFigure) {
    if (lockedReason(figure)) return;
    options.setCollapsed(figure, !geometry.value.collapsed[figure]);
  }

  // ── Putting a layout on screen ────────────────────────────────────────────

  /**
   * Whether the panels are being driven by the store rather than by the user.
   *
   * A panel emits `@collapse` when told to collapse and the group emits
   * `@layout` when told to resize, so without this the store write and the panel
   * call chase each other round once on every toggle.
   */
  let syncing = false;

  /**
   * Whether the stored state has been pushed into the panels yet.
   *
   * A panel emits `@expand` as it registers, which arrives *before* anything has
   * had a chance to tell it that this figure was left collapsed — so without
   * this every reload wrote "expanded" over the state it was about to restore,
   * and the collapse survived exactly as long as it took the panel to mount.
   */
  let restored = false;

  /**
   * Suppresses everything the panels say while a layout switch is in flight.
   *
   * Changing a layout changes every panel's `min-size` and `max-size` at once,
   * and reka re-validates its layout against the new constraints *before* the
   * post-flush watch below can push the new geometry in — emitting `@layout` as
   * it goes. That emission is not a drag, but it looked exactly like one: it
   * landed in the layout being switched *to* and overwrote the sizes that layout
   * had been storing, so coming back to a layout showed a rearrangement of the
   * one before it rather than the arrangement the user left.
   *
   * `sync`, because it has to be set before reka's own watchers run.
   */
  watch(layoutId, () => {
    syncing = true;
  }, { flush: "sync" });

  /**
   * Whether each group has a layout of its own yet.
   *
   * Reka emits `@layout` exactly once it has one, and it throws "Panel size not
   * found" if a panel is collapsed before that — the panels register before the
   * group has computed anything, and the inner group registers later still.
   * Measuring the boxes is not enough to know: an element has a height well
   * before the splitter inside it has divided it.
   */
  const ready = ref<Record<ResultsGroup, boolean>>({ main: false, charts: false });

  function onPanelState(figure: ResultsFigure, collapsed: boolean) {
    if (syncing || !restored) return;
    if (!isCollapsible(figure)) return;
    options.setCollapsed(figure, collapsed);
  }

  /**
   * A group's drag, recorded against the layout on screen.
   *
   * **Only when both its panels are open.** A collapsed panel is pinned to its
   * title bar, so the layout reka emits while one is folded away says nothing
   * about how the user wants the two divided — storing it means unfolding the
   * panel later hands it seven percent of the height. Skipping it is what makes
   * expanding a figure restore the ratio it had before, which is the thing that
   * was missing.
   */
  function onLayout(group: ResultsGroup, sizes: number[]) {
    // Before the guards: an emission this ignores is still proof the group has a
    // layout, which is the one thing that makes it safe to drive its panels.
    if (!ready.value[group]) ready.value = { ...ready.value, [group]: true };
    if (syncing || !restored) return;
    const members = RESULTS_FIGURES.filter((figure) => SLOT[figure].group === group);
    if (group === "main" && bothChartsCollapsed.value) return;
    if (members.some((figure) => collapsedNow(figure))) return;
    options.setSizes(group, sizes);
  }

  /** Whether a group's two panels are both free to take a stored size. */
  function groupIsFree(group: ResultsGroup): boolean {
    const members = RESULTS_FIGURES.filter((figure) => SLOT[figure].group === group);
    if (members.some((figure) => collapsedNow(figure))) return false;
    return !(group === "main" && bothChartsCollapsed.value);
  }

  /** Which application of a layout is the current one — see the second pass. */
  let applyToken = 0;

  /**
   * Puts each group's leader at its stored size, where the group is free to take
   * one.
   *
   * Resizing the leader is enough: a two-panel group gives the remainder to the
   * other. A group with a collapsed panel is left alone — the pinning decides it,
   * and the stored sizes are the *open* arrangement, which is the whole point of
   * `onLayout` not recording one.
   */
  function applySizes(state: ResultsGeometry) {
    for (const [group, leader] of [
      ["main", "map"],
      ["charts", "timeseries"],
    ] as [ResultsGroup, ResultsFigure][]) {
      if (!groupIsFree(group)) continue;
      if (group === "main" && !hasMap.value) continue;
      panelOf(leader)?.resize(state.sizes[group][0]);
    }
  }

  const onNextFrame =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (callback: () => void) => queueMicrotask(callback);

  /**
   * Pushes the layout's stored state into the panels.
   *
   * Watches the registry as well as the state, because the map panel only mounts
   * once the geography has arrived — a beat after everything else — and until it
   * has registered there is nothing to collapse.
   */
  watch(
    [
      () => geometry.value,
      () => direction.value,
      registry,
      ready,
      mainSize,
      chartsSize,
    ],
    ([state]) => {
      // Not before every group has a layout of its own, and a size: reka throws
      // "Panel size not found" if a panel is collapsed before the group it
      // belongs to has divided itself. `syncing` is still cleared, because a
      // layout switch sets it synchronously and this is the only thing that
      // hands it back.
      const settled =
        chartsSize.value && ready.value.charts &&
        (!hasMap.value || (mainSize.value && ready.value.main));
      if (!settled) {
        queueMicrotask(() => {
          syncing = false;
        });
        return;
      }

      syncing = true;

      for (const figure of RESULTS_FIGURES) {
        const panel = panelOf(figure);
        if (!panel) continue;
        const wanted = state.collapsed[figure] && isCollapsible(figure);
        // Its own `data-state` rather than a shadow copy: reka snaps a panel
        // dragged below `minSize` to collapsed on its own, so this is not the
        // only thing that changes it. A panel that is not collapsible carries no
        // `data-state` at all, which reads as expanded — which it is.
        const collapsed = panel.$el?.dataset.state === "collapsed";
        if (collapsed === wanted) continue;
        if (wanted) panel.collapse();
        else panel.expand();
      }

      // Sizes after the collapses, because a collapsed panel is pinned and a
      // group holding one takes no stored size at all.
      applySizes(state);

      // And again once the boxes have settled. Every constraint here is a
      // percentage of a *measured* box, and mid-switch those measurements are
      // one frame behind: resizing `main` changes the height the charts column
      // divides, so the floors the charts were just clamped against were the
      // previous layout's. Coming back to the stacked layout from the totals one
      // landed its charts at 51/49 rather than the 61/39 it was left at — and
      // then reka emitted that, and it was stored as if the user had dragged it.
      //
      // The token is what stops a switch that has already been superseded from
      // applying the layout before last.
      const token = (applyToken += 1);
      onNextFrame(() => {
        if (token !== applyToken) return;
        measure();
        applySizes(state);
        // After the layout has settled, not before: reka resizes synchronously
        // but emits on the next tick.
        queueMicrotask(() => {
          syncing = false;
          restored = true;
        });
      });
    },
    // `post`, so the pinned `min-size`/`max-size` a collapsed figure carries have
    // been re-rendered before `expand()` is called. Run before them and the panel
    // is told to expand while still capped at its title bar, and reka does the
    // only thing it can: leaves it shut.
    { deep: true, immediate: true, flush: "post" },
  );

  const context: FigurePanelsContext = {
    register,
    unregister,
    bindingFor,
    isOpen,
    isCollapsible,
    lockedReason,
    toggle,
    onPanelState,
  };

  return {
    context,
    mainEl,
    chartsEl,
    chartsColumnBinding,
    visibleFigures,
    onLayout,
  };
}
