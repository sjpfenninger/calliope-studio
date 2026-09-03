import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { defineComponent, ref, shallowRef, type Ref } from "vue";

import {
  RESULTS_FIGURES,
  defaultGeometry,
  type ResultsFigure,
  type ResultsGeometry,
  type ResultsGroup,
} from "@/lib/resultsLayouts";
import {
  useFigurePanels,
  type ElementHandle,
  type PanelHandle,
} from "./useFigurePanels";

/**
 * The results view's panel choreography, driven without reka.
 *
 * Every rule in the composable was paid for by a bug that nothing threw on: a
 * chart that reopened itself when its neighbour folded, a layout that came back
 * as a rearrangement of the one before it, a collapse that survived exactly as
 * long as it took the panel to mount. None of those is visible to a type-check,
 * and the browser checks see only the end state. These tests hold the
 * *sequence* — what is told to which panel, when, and what the panels are
 * allowed to say back — against fake handles that record it.
 *
 * What cannot be reached here: reka's own re-validation against a changed
 * `min-size`/`max-size`, which is what makes the `syncing` guard necessary. The
 * fakes emit nothing on their own, so the tests call `onLayout` at the moments
 * reka would.
 */

/**
 * A `ResizeObserver` that records what it was given and never fires.
 *
 * happy-dom's own is just as silent but says nothing about `disconnect`, and
 * whether the observer is let go on unmount is one of the things pinned.
 */
class RecordingResizeObserver {
  static instances: RecordingResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;

  constructor(readonly callback: ResizeObserverCallback) {
    RecordingResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }
}

/**
 * Frames under the test's control.
 *
 * The composable captures `requestAnimationFrame` when it is set up, so the
 * stub has to be in place before mounting. A queue rather than the real thing:
 * the second pass and the token that guards it are *about* what happens inside
 * one frame, and a test that waits a timer cannot say which frame it reached.
 */
let frames: Array<() => void> = [];

function flushFrames(): void {
  const due = frames;
  frames = [];
  for (const callback of due) callback();
}

/** An element with a measured box; happy-dom's own rects are all zero. */
function box(width: number, height: number): HTMLElement {
  const element = document.createElement("div");
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
  return element;
}

interface FakePanel extends PanelHandle {
  collapse: Mock<() => void>;
  expand: Mock<() => void>;
  resize: Mock<(size: number) => void>;
  $el: HTMLElement;
}

/**
 * A panel that keeps its `data-state` the way reka does, so the composable can
 * read back what it was told. A real panel carries the attribute only when it
 * is collapsible; the fake models that case.
 */
function fakePanel(): FakePanel {
  const $el = document.createElement("div");
  $el.dataset.state = "expanded";
  return {
    $el,
    collapse: vi.fn(() => {
      $el.dataset.state = "collapsed";
    }),
    expand: vi.fn(() => {
      $el.dataset.state = "expanded";
    }),
    resize: vi.fn(),
  };
}

function arrangement(
  main: number[],
  charts: number[],
  collapsed: Partial<Record<ResultsFigure, boolean>> = {},
): ResultsGeometry {
  return {
    sizes: { main, charts },
    collapsed: { map: false, timeseries: false, static: false, ...collapsed },
  };
}

/** The group boxes: 1001×2001 for `main`, 501 tall for `charts`. */
const MAIN_WIDTH = 2001;
const MAIN_HEIGHT = 1001;
const CHARTS_HEIGHT = 501;

const wrappers: VueWrapper[] = [];

/**
 * Mounts the composable inside a throwaway component: it registers a
 * `beforeUnmount` hook and post-flush watches, neither of which exists outside
 * a setup scope.
 */
function harness(
  init: {
    hasMap?: boolean;
    direction?: "vertical" | "horizontal";
    geometry?: ResultsGeometry;
  } = {},
) {
  const hasMap = ref(init.hasMap ?? true);
  const layoutId = ref("stacked");
  const direction = ref<"vertical" | "horizontal">(init.direction ?? "vertical");
  const geometry = ref<ResultsGeometry>(init.geometry ?? defaultGeometry("stacked"));
  const mainEl = shallowRef<HTMLElement | null>(null);
  const chartsEl = shallowRef<HTMLElement | null>(null);
  const setCollapsed = vi.fn<(figure: ResultsFigure, collapsed: boolean) => void>();
  const setSizes = vi.fn<(group: ResultsGroup, sizes: number[]) => void>();

  let panels!: ReturnType<typeof useFigurePanels>;
  const wrapper: VueWrapper = mount(
    defineComponent({
      setup() {
        panels = useFigurePanels({
          mainEl,
          chartsEl,
          hasMap,
          layoutId,
          direction,
          geometry,
          setCollapsed,
          setSizes,
        });
        return () => null;
      },
    }),
  );
  wrappers.push(wrapper);

  const handles: Record<ResultsFigure, FakePanel> = {
    map: fakePanel(),
    timeseries: fakePanel(),
    static: fakePanel(),
  };
  const headers: Record<ResultsFigure, Ref<ElementHandle | null>> = {
    map: ref(null),
    timeseries: ref(null),
    static: ref(null),
  };

  function mountGroups() {
    mainEl.value = box(MAIN_WIDTH, MAIN_HEIGHT);
    chartsEl.value = box(1200, CHARTS_HEIGHT);
  }

  function register(figure: ResultsFigure, headerHeight = 28) {
    headers[figure].value = { $el: box(400, headerHeight) };
    panels.context.register(figure, {
      header: headers[figure],
      panel: ref<PanelHandle | null>(handles[figure]),
    });
  }

  function registerAll() {
    for (const figure of RESULTS_FIGURES) register(figure);
  }

  /** What the ui store does on a layout switch: id, geometry and direction at once. */
  function switchTo(
    id: string,
    next: ResultsGeometry,
    nextDirection: "vertical" | "horizontal" = "vertical",
  ) {
    layoutId.value = id;
    geometry.value = next;
    direction.value = nextDirection;
  }

  function clearHandles() {
    for (const handle of Object.values(handles)) {
      handle.collapse.mockClear();
      handle.expand.mockClear();
      handle.resize.mockClear();
    }
  }

  function resizes(figure: ResultsFigure): number[] {
    return handles[figure].resize.mock.calls.map(([size]) => size);
  }

  return {
    panels,
    wrapper,
    hasMap,
    direction,
    geometry,
    setCollapsed,
    setSizes,
    handles,
    headers,
    mountGroups,
    register,
    registerAll,
    switchTo,
    clearHandles,
    resizes,
  };
}

type Harness = ReturnType<typeof harness>;

/**
 * Brings a harness to the state a mounted results view reaches: groups
 * measured, every figure registered, both groups' first `@layout` in, and both
 * passes of the stored state applied. The handles are cleared afterwards, so a
 * test reads only what it causes.
 */
async function settle(h: Harness) {
  h.mountGroups();
  h.registerAll();
  await flushPromises();
  h.panels.onLayout("main", h.geometry.value.sizes.main);
  h.panels.onLayout("charts", h.geometry.value.sizes.charts);
  await flushPromises();
  flushFrames();
  await flushPromises();
  h.clearHandles();
}

/** A layout switch, carried through both passes. */
async function settleSwitch(
  h: Harness,
  id: string,
  next: ResultsGeometry,
  direction: "vertical" | "horizontal" = "vertical",
) {
  h.switchTo(id, next, direction);
  await flushPromises();
  flushFrames();
  await flushPromises();
}

beforeEach(() => {
  frames = [];
  RecordingResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.push(callback);
    return frames.length;
  });
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

describe("useFigurePanels", () => {
  describe("collapsibility", () => {
    it("lets a chart fold in either direction, and the map only when stacked", () => {
      // A horizontally collapsed card would need a horizontal title bar, which
      // is not a thing: side by side, the map is put away by choosing another
      // layout. A chevron offered there folds the map to nothing.
      const h = harness();
      expect(h.panels.context.isCollapsible("map")).toBe(true);
      expect(h.panels.context.isCollapsible("timeseries")).toBe(true);
      expect(h.panels.context.isCollapsible("static")).toBe(true);

      h.direction.value = "horizontal";
      expect(h.panels.context.isCollapsible("map")).toBe(false);
      expect(h.panels.context.isCollapsible("timeseries")).toBe(true);
      expect(h.panels.context.isCollapsible("static")).toBe(true);
    });

    it("reads a stored collapsed map as open side by side", () => {
      // Each layout keeps its own flags, and one can say the map is folded
      // while the direction says it cannot be. Honouring the flag would hide
      // the map with no chevron to bring it back.
      const h = harness({
        direction: "horizontal",
        geometry: arrangement([52, 48], [58, 42], { map: true }),
      });
      expect(h.panels.context.isOpen("map")).toBe(true);
      expect(h.panels.context.bindingFor("map").value.collapsible).toBe(false);
    });

    it("shows the map only when there is geography for it", () => {
      const h = harness({ hasMap: false });
      expect(h.panels.visibleFigures.value).toEqual(["timeseries", "static"]);
      h.hasMap.value = true;
      expect(h.panels.visibleFigures.value).toEqual(["map", "timeseries", "static"]);
    });
  });

  describe("locking", () => {
    const other = "Expand the other chart first — one has to stay open.";
    const another = "Expand another figure first — one has to stay open.";

    it("keeps one chart open when the column cannot shrink", () => {
      // As the root group of a model with no geography, or as a column beside
      // the map, the charts column has the full height whatever its contents
      // do — and two panels both pinned to a title bar cannot fill it.
      const noMap = harness({
        hasMap: false,
        geometry: arrangement([34, 66], [61, 39], { timeseries: true }),
      });
      expect(noMap.panels.context.lockedReason("static")).toBe(other);

      const beside = harness({
        direction: "horizontal",
        geometry: arrangement([52, 48], [58, 42], { static: true }),
      });
      expect(beside.panels.context.lockedReason("timeseries")).toBe(other);
      // The map beside them is not the reason, and is itself not collapsible.
      expect(beside.panels.context.lockedReason("map")).toBe("");
    });

    it("lets both charts fold under a stacked map", () => {
      // The one case where something else can take the height the column
      // gives up. Locking here would make the map layout's "only the map"
      // arrangement unreachable by hand.
      const h = harness({
        geometry: arrangement([34, 66], [61, 39], { timeseries: true }),
      });
      expect(h.panels.context.lockedReason("static")).toBe("");
    });

    it("keeps the last visible figure open", () => {
      // With every panel pinned to its title bar there is a band of space with
      // nothing entitled to it, and one figure is handed it: an empty card
      // under its own title. Collapsing everything also focuses on nothing.
      const h = harness({
        geometry: arrangement([34, 66], [61, 39], { timeseries: true, static: true }),
      });
      expect(h.panels.context.lockedReason("map")).toBe(another);

      const noMap = harness({
        hasMap: false,
        geometry: arrangement([34, 66], [61, 39], { static: true }),
      });
      expect(noMap.panels.context.lockedReason("timeseries")).toBe(other);
    });

    it("never locks a figure that is already folded", () => {
      // The lock exists to keep one figure open; a folded one is the one the
      // user needs to be able to bring back, whatever the others are doing.
      const h = harness({
        hasMap: false,
        geometry: arrangement([34, 66], [61, 39], { static: true }),
      });
      expect(h.panels.context.lockedReason("static")).toBe("");
      h.panels.context.toggle("static");
      expect(h.setCollapsed).toHaveBeenCalledWith("static", false);
    });

    it("makes toggle a no-op on a locked figure", () => {
      const h = harness({
        geometry: arrangement([34, 66], [61, 39], { timeseries: true, static: true }),
      });
      h.panels.context.toggle("map");
      expect(h.setCollapsed).not.toHaveBeenCalled();

      h.panels.context.toggle("timeseries");
      expect(h.setCollapsed).toHaveBeenCalledWith("timeseries", false);
    });
  });

  describe("panel bindings", () => {
    it("pins a folded figure to its title bar, top and bottom", () => {
      // Collapsing a panel does not make its space disappear, and the splitter
      // will hand the slack to a panel that is itself collapsed — which
      // silently reopened it. `minSize === maxSize` leaves it nowhere to go.
      const h = harness({
        geometry: arrangement([34, 66], [61, 39], { static: true }),
      });
      const binding = h.panels.context.bindingFor("static").value;
      expect(binding.collapsible).toBe(true);
      expect(binding.minSize).toBe(binding.collapsedSize);
      expect(binding.maxSize).toBe(binding.collapsedSize);
    });

    it("falls back to safe percentages before anything has been measured", () => {
      // The panels bind before the boxes have a size. A zero divisor here
      // would put NaN on every `min-size`, and reka's answer to that is a
      // redistribution nobody asked for.
      const h = harness({
        geometry: arrangement([34, 66], [61, 39], { static: true }),
      });
      const timeseries = h.panels.context.bindingFor("timeseries").value;
      expect(timeseries).toEqual({
        order: 1,
        defaultSize: 61,
        minSize: 15,
        maxSize: 100,
        collapsedSize: 5,
        collapsible: true,
      });
      expect(h.panels.context.bindingFor("static").value.minSize).toBe(5);
      expect(h.panels.context.bindingFor("map").value.defaultSize).toBe(34);

      const column = h.panels.chartsColumnBinding.value;
      expect(column).toEqual({
        order: 2,
        defaultSize: 66,
        minSize: 20,
        maxSize: 100,
        collapsible: false,
      });

      // Both charts folded under a stacked map: the column is pinned too, to
      // an unmeasured 12 percent.
      h.geometry.value = arrangement([34, 66], [61, 39], {
        timeseries: true,
        static: true,
      });
      expect(h.panels.chartsColumnBinding.value.minSize).toBe(12);
      expect(h.panels.chartsColumnBinding.value.maxSize).toBe(12);
    });

    it("measures the collapsed size from the header, not a constant", async () => {
      // "A header is 28px" was true of the map and of neither chart: their
      // controls wrap at a narrow width, and a collapsed figure clipped its own
      // title bar. What a collapsed panel has to be is *this* header, now.
      const h = harness();
      h.mountGroups();
      h.registerAll();
      await flushPromises();

      // (28 + 10) of the 1000px the main group's panels divide.
      expect(h.panels.context.bindingFor("map").value.collapsedSize).toBeCloseTo(3.8);
      expect(h.panels.context.bindingFor("map").value.minSize).toBeCloseTo(15);
      // (28 + 10) of the charts column's 500.
      const timeseries = h.panels.context.bindingFor("timeseries").value;
      expect(timeseries.collapsedSize).toBeCloseTo(7.6);
      expect(timeseries.minSize).toBeCloseTo(30);

      // The header wraps onto a second row, and the whole thing follows.
      h.headers.timeseries.value = { $el: box(400, 140) };
      await flushPromises();
      const wrapped = h.panels.context.bindingFor("timeseries").value;
      expect(wrapped.collapsedSize).toBeCloseTo(30);
      // The drag floor stays clear of the collapsed size: reka cannot tell "as
      // small as it goes" from "collapsed" when the two coincide, and a chart
      // dragged to exactly its title bar then has its chevron pointing the
      // wrong way.
      expect(wrapped.minSize).toBeCloseTo(32);
    });

    it("uses the wide floor for the map beside the charts", async () => {
      // Side by side the constraint is the chrome: the map's pickers and the
      // time series' control groups wrap below about 260px, and a header
      // taller than its plot area is not a figure.
      const h = harness({
        direction: "horizontal",
        geometry: defaultGeometry("beside"),
      });
      h.mountGroups();
      h.registerAll();
      await flushPromises();

      const map = h.panels.context.bindingFor("map").value;
      // 260 of the 2000px the main group divides along its width.
      expect(map.minSize).toBeCloseTo(13);
      expect(map.maxSize).toBe(100);
      expect(map.collapsedSize).toBeUndefined();
      expect(map.collapsible).toBe(false);
      expect(h.panels.chartsColumnBinding.value.minSize).toBeCloseTo(13);
    });

    it("pins the charts column only when both charts fold under a stacked map", async () => {
      // The inner group's available height then becomes exactly two title bars
      // and the rule between them, so the two collapsed percentages sum to 100
      // and the splitter has no slack to put anywhere. Without it, collapsing
      // the second chart silently reopened the first.
      const h = harness({
        geometry: arrangement([34, 66], [61, 39], { timeseries: true, static: true }),
      });
      h.mountGroups();
      h.registerAll();
      await flushPromises();

      // (28 + 28 + 2 × 10 + 1) of 1000.
      const pinned = h.panels.chartsColumnBinding.value;
      expect(pinned.minSize).toBeCloseTo(7.7);
      expect(pinned.maxSize).toBeCloseTo(7.7);

      // Not as the root group: nothing else can take the height.
      h.hasMap.value = false;
      const root = h.panels.chartsColumnBinding.value;
      expect(root.minSize).toBeCloseTo(15);
      expect(root.maxSize).toBe(100);
    });
  });

  describe("putting a layout on screen", () => {
    it("drives the panels only once every group has a layout and a size", async () => {
      // reka throws "Panel size not found" if a panel is collapsed before its
      // group has divided itself, and the inner group registers later than the
      // outer. A measured box is not enough to know: an element has a height
      // well before the splitter inside it has done anything.
      const h = harness({ geometry: defaultGeometry("map") });
      h.mountGroups();
      h.registerAll();
      await flushPromises();
      expect(h.handles.static.collapse).not.toHaveBeenCalled();
      expect(h.handles.map.resize).not.toHaveBeenCalled();

      h.panels.onLayout("charts", [70, 30]);
      await flushPromises();
      expect(h.handles.static.collapse).not.toHaveBeenCalled();

      h.panels.onLayout("main", [62, 38]);
      await flushPromises();
      expect(h.handles.static.collapse).toHaveBeenCalledTimes(1);
      expect(h.resizes("map")).toEqual([62]);
    });

    it("applies the layout twice, once now and once a frame later", async () => {
      // Every constraint is a percentage of a measured box, and mid-switch the
      // measurements are a frame behind: resizing `main` changes the height the
      // charts column divides. Coming back to the stacked layout landed its
      // charts at 51/49 rather than the 61/39 they were left at — and reka
      // then emitted that as if it were a drag.
      const h = harness();
      await settle(h);

      h.switchTo("custom", arrangement([40, 60], [55, 45]));
      await flushPromises();
      expect(h.resizes("map")).toEqual([40]);
      expect(h.resizes("timeseries")).toEqual([55]);

      flushFrames();
      expect(h.resizes("map")).toEqual([40, 40]);
      expect(h.resizes("timeseries")).toEqual([55, 55]);
    });

    it("tells only the panels whose own state disagrees with the layout", async () => {
      // reka snaps a panel dragged below `minSize` to collapsed on its own, so
      // the stored flag is not the only thing that changes a panel's state. A
      // shadow copy would tell an already-collapsed panel to collapse, and the
      // emission that follows chases the store write round once more.
      const h = harness();
      await settle(h);

      h.handles.static.$el.dataset.state = "collapsed";
      h.switchTo("custom", arrangement([34, 66], [61, 39], { timeseries: true, static: true }));
      await flushPromises();

      expect(h.handles.static.collapse).not.toHaveBeenCalled();
      expect(h.handles.timeseries.collapse).toHaveBeenCalledTimes(1);
      expect(h.handles.map.expand).not.toHaveBeenCalled();
    });

    it("lets a second switch in the same frame supersede the first", async () => {
      // Without the token, the first switch's deferred pass would run after the
      // second's synchronous one and put the leader back at the layout before
      // last — then reka would emit that, and it would be stored.
      const h = harness();
      await settle(h);

      h.switchTo("first", arrangement([62, 38], [70, 30]));
      await flushPromises();
      h.switchTo("second", arrangement([20, 80], [50, 50]));
      await flushPromises();
      expect(frames).toHaveLength(2);

      flushFrames();
      expect(h.resizes("map")).toEqual([62, 20, 20]);
      expect(h.resizes("timeseries")).toEqual([70, 50, 50]);
    });

    it("leaves a group with a folded panel at its pinned size", async () => {
      // The stored sizes are the *open* arrangement — `onLayout` records
      // nothing else — so a group holding a collapsed panel takes none of them.
      // Resizing its leader anyway would fight the pin it was just given.
      const h = harness();
      await settle(h);

      await settleSwitch(h, "map", defaultGeometry("map"));
      expect(h.handles.static.collapse).toHaveBeenCalledTimes(1);
      expect(h.resizes("map")).toEqual([62, 62]);
      expect(h.resizes("timeseries")).toEqual([]);
    });

    it("resizes no map for a model with no geography", async () => {
      // There is no `main` group at all then; the charts are the root.
      const h = harness({ hasMap: false });
      h.mountGroups();
      h.register("timeseries");
      h.register("static");
      await flushPromises();
      h.panels.onLayout("charts", [61, 39]);
      await flushPromises();
      flushFrames();
      await flushPromises();

      expect(h.resizes("timeseries")).toEqual([61, 61]);
      expect(h.resizes("map")).toEqual([]);
    });
  });

  describe("what the panels say back", () => {
    it("records nothing while the stored state is being restored", async () => {
      // A panel emits `@expand` as it registers, before anything has told it
      // this figure was left collapsed — so every reload used to write
      // "expanded" over the state it was about to restore. Likewise the first
      // `@layout` of each group is reka dividing its box, not a drag.
      const h = harness({ geometry: defaultGeometry("map") });
      h.mountGroups();
      h.registerAll();
      h.panels.context.onPanelState("static", false);
      await flushPromises();

      h.panels.onLayout("main", [50, 50]);
      h.panels.onLayout("charts", [50, 50]);
      await flushPromises();
      flushFrames();
      await flushPromises();

      expect(h.setCollapsed).not.toHaveBeenCalled();
      expect(h.setSizes).not.toHaveBeenCalled();
    });

    it("ignores the layout reka emits mid-switch and stores the drag that follows", async () => {
      // Changing a layout changes every panel's constraints at once, and reka
      // re-validates against them *before* the new geometry is pushed in,
      // emitting `@layout` as it goes. That emission landed in the layout being
      // switched to, overwriting the sizes it had been keeping.
      const h = harness();
      await settle(h);

      h.switchTo("custom", arrangement([40, 60], [55, 45]));
      await flushPromises();
      h.panels.onLayout("main", [50, 50]);
      expect(h.setSizes).not.toHaveBeenCalled();

      flushFrames();
      await flushPromises();
      h.panels.onLayout("main", [50, 50]);
      expect(h.setSizes).toHaveBeenCalledTimes(1);
      expect(h.setSizes).toHaveBeenCalledWith("main", [50, 50]);
    });

    it("does not store a drag while either panel of the group is folded", async () => {
      // A collapsed panel is pinned to its title bar, so the layout reka emits
      // while one is folded says nothing about how the user wants the two
      // divided: storing it hands the panel seven percent of the height when it
      // is unfolded later.
      const h = harness();
      await settle(h);

      await settleSwitch(h, "map", defaultGeometry("map"));
      h.panels.onLayout("charts", [93, 7]);
      expect(h.setSizes).not.toHaveBeenCalled();
      h.panels.onLayout("main", [40, 60]);
      expect(h.setSizes).toHaveBeenCalledWith("main", [40, 60]);

      // The main group's second panel is the charts column, and it is pinned
      // too when both charts are folded.
      h.setSizes.mockClear();
      await settleSwitch(
        h,
        "both",
        arrangement([34, 66], [61, 39], { timeseries: true, static: true }),
      );
      h.panels.onLayout("main", [90, 10]);
      expect(h.setSizes).not.toHaveBeenCalled();
    });

    it("writes a user's collapse to the store, but not a panel's that cannot fold", async () => {
      // Side by side the map has no chevron; a `@collapse` from it would be
      // reka snapping it at a drag, and storing that folds a figure the user
      // has no control to unfold.
      const h = harness({
        direction: "horizontal",
        geometry: defaultGeometry("beside"),
      });
      await settle(h);

      h.panels.context.onPanelState("map", true);
      expect(h.setCollapsed).not.toHaveBeenCalled();

      h.panels.context.onPanelState("static", true);
      expect(h.setCollapsed).toHaveBeenCalledWith("static", true);
    });

    it("ignores a panel's state while a switch is driving it", async () => {
      // `collapse()` makes the panel emit `@collapse`; written back, that is
      // the store and the panel chasing each other round once per toggle.
      const h = harness();
      await settle(h);

      h.switchTo("map", defaultGeometry("map"));
      await flushPromises();
      h.panels.context.onPanelState("static", true);
      expect(h.setCollapsed).not.toHaveBeenCalled();
    });
  });

  describe("measurement", () => {
    it("watches both groups and every header with one observer, and lets it go on unmount", async () => {
      // A window resize reflows the wrapped headers *and* the groups, and a
      // callback per target could see a half-updated set. Left connected past
      // unmount, it measures into a dead scope on every resize.
      const h = harness();
      h.mountGroups();
      h.registerAll();
      await flushPromises();

      const [observer] = RecordingResizeObserver.instances;
      expect(RecordingResizeObserver.instances).toHaveLength(1);
      expect(observer.observed).toHaveLength(5);
      expect(observer.disconnected).toBe(false);

      h.wrapper.unmount();
      expect(observer.disconnected).toBe(true);
    });

    it("replaces the observer when the map registers a beat later", async () => {
      // The map panel waits on the geography, so it registers after the
      // charts. The earlier observer must go, or every header ends up measured
      // by two of them.
      const h = harness();
      h.mountGroups();
      h.register("timeseries");
      h.register("static");
      await flushPromises();
      const [first] = RecordingResizeObserver.instances;
      expect(first.observed).toHaveLength(4);

      h.register("map");
      await flushPromises();
      expect(first.disconnected).toBe(true);
      const second = RecordingResizeObserver.instances[1];
      expect(second.observed).toHaveLength(5);
      expect(second.disconnected).toBe(false);
    });

    it("remeasures when the direction flips", async () => {
      // The group's box does not change, so the observer never fires — but
      // which of its two dimensions the panels divide has, and every percentage
      // is computed from it.
      const h = harness();
      h.mountGroups();
      h.registerAll();
      await flushPromises();
      // 150 of the 1000px height.
      expect(h.panels.context.bindingFor("map").value.minSize).toBeCloseTo(15);

      h.direction.value = "horizontal";
      await flushPromises();
      // 260 of the 2000px width.
      expect(h.panels.context.bindingFor("map").value.minSize).toBeCloseTo(13);
    });
  });
});
