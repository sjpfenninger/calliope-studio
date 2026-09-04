import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

/**
 * ECharts draws to a canvas, and happy-dom has none: the real `init` succeeds
 * but the first `setOption` throws inside the painter. A recorder stands in
 * for the instance, so what is asserted is exactly what the component *told*
 * ECharts — the option, the `notMerge` flag, the actions — which is where every
 * bug this file pins lived. Pixels stay with `scripts/smoke-charts.mjs`.
 */
interface Recorder {
  setOption: ReturnType<typeof vi.fn>;
  getOption: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  dispatchAction: ReturnType<typeof vi.fn>;
  getModel: ReturnType<typeof vi.fn>;
  handlers: Record<string, (params: unknown) => void>;
  fire: (event: string, params: unknown) => void;
}

const instances: Recorder[] = [];

function recorder(): Recorder {
  const handlers: Record<string, (params: unknown) => void> = {};
  const self: Recorder = {
    setOption: vi.fn(),
    getOption: vi.fn(() => ({})),
    clear: vi.fn(),
    dispose: vi.fn(),
    resize: vi.fn(),
    on: vi.fn((event: string, handler: (params: unknown) => void) => {
      handlers[event] = handler;
    }),
    dispatchAction: vi.fn(),
    getModel: vi.fn(() => ({ getComponent: () => undefined })),
    handlers,
    fire: (event, params) => handlers[event]?.(params),
  };
  instances.push(self);
  return self;
}

vi.mock("echarts", () => ({
  init: vi.fn(() => recorder()),
  registerTheme: vi.fn(),
}));

import type { ResultFrame } from "@/api/results";
import { useUiStore } from "@/stores/ui";
import ResultChart from "./ResultChart.vue";

class QuietResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

const HOUR = 3_600_000;

function frame(overrides: Partial<ResultFrame> & { variable?: string } = {}): ResultFrame {
  const index = [0, 1, 2, 3].map((i) => 1_104_537_600_000 + i * HOUR);
  return {
    index,
    indexName: "timesteps",
    indexIsTime: true,
    series: [{ key: "ccgt", values: Float64Array.from([1, 2, 3, 4]), dims: { techs: "ccgt" } }],
    variable: "flow_out",
    order: "time",
    seriesDims: ["techs"],
    unit: null,
    ...overrides,
  };
}

function categorical(): ResultFrame {
  return frame({
    index: ["region1", "region2", "region3"],
    indexName: "nodes",
    indexIsTime: false,
    series: [{ key: "ccgt", values: Float64Array.from([1, 2, 3]), dims: { techs: "ccgt" } }],
  });
}

function render(props: Partial<InstanceType<typeof ResultChart>["$props"]> = {}) {
  return mount(ResultChart, {
    props: { frame: frame(), kind: "bar", ...props },
    attachTo: document.body,
    global: {
      stubs: {
        // The real one needs a `TooltipProvider`; what matters here is the click.
        TooltipButton: {
          props: ["testid"],
          emits: ["click"],
          template: '<button :data-testid="testid" @click="$emit(\'click\')" />',
        },
      },
    },
  });
}

const last = () => instances[instances.length - 1]!;
const lastCall = (chart: Recorder) => {
  const calls = chart.setOption.mock.calls;
  return calls[calls.length - 1]! as [Record<string, unknown>, { notMerge: boolean }];
};
const dataZooms = (option: Record<string, unknown>) => option.dataZoom as Array<Record<string, unknown>>;

enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
  instances.length = 0;
  vi.stubGlobal("ResizeObserver", QuietResizeObserver);
  delete (window as unknown as { __cgCharts?: unknown }).__cgCharts;
});

describe("ResultChart", () => {
  describe("replace or merge", () => {
    // A merged option never removes a series and never redraws values whose
    // names are unchanged, so the decision has to be right on both sides: a
    // needless replace costs the reader their zoom, a missed one draws stale
    // numbers under fresh labels.
    it("replaces on first draw and merges a frame of the same shape", async () => {
      const wrapper = render();
      expect(lastCall(last())[1].notMerge).toBe(true);

      await wrapper.setProps({ frame: frame({ series: [{ key: "ccgt", values: Float64Array.from([9, 9, 9, 9]), dims: { techs: "ccgt" } }] }) });
      expect(lastCall(last())[1].notMerge).toBe(false);
    });

    it.each([
      ["the variable", { frame: frame({ variable: "flow_in" }) }],
      ["the plot kind", { kind: "line" as const }],
      ["the axis kind", { frame: categorical() }],
      ["the series names", { frame: frame({ series: [{ key: "battery", values: Float64Array.from([1, 2, 3, 4]), dims: { techs: "battery" } }] }) }],
      ["whether colour is on the axis", { indexColors: { region1: "#000" } }],
      ["the unit label", { unit: { label: "GWh", factor: 1 } }],
      ["the unit factor", { unit: { label: "", factor: 0.001 } }],
    ])("replaces when %s changes", async (_, next) => {
      const wrapper = render();
      await wrapper.setProps(next);
      expect(lastCall(last())[1].notMerge).toBe(true);
    });

    it("merges when only the precision changes", async () => {
      // Two formatter functions swapped and nothing else; a replace here would
      // rebuild every series on every keystroke in the precision field.
      const wrapper = render();
      await wrapper.setProps({ precision: 2 });
      expect(lastCall(last())[1].notMerge).toBe(false);
    });

    it("the factor alone forces a replace, because every value moved", async () => {
      // Same series names, every number a thousandth of what it was: a merge
      // keyed on names kept drawing the old numbers, which looked exactly like
      // the unit setting doing nothing.
      const wrapper = render({ unit: { label: "kWh", factor: 1 } });
      await wrapper.setProps({ unit: { label: "kWh", factor: 0.001 } });
      expect(lastCall(last())[1].notMerge).toBe(true);
    });
  });

  describe("zoom", () => {
    const zoomIn = (chart: Recorder) => chart.fire("datazoom", { start: 25, end: 50 });

    it("carries a window across a replace on a time axis, clipped to the new extent", async () => {
      const wrapper = render();
      const chart = last();
      zoomIn(chart);
      await nextTick();

      await wrapper.setProps({ frame: frame({ variable: "flow_in" }) });
      const [option, flags] = lastCall(chart);
      expect(flags.notMerge).toBe(true);
      for (const zoom of dataZooms(option)) {
        expect(zoom.startValue).toBe(1_104_537_600_000 + 0.75 * HOUR);
        expect(zoom.endValue).toBe(1_104_537_600_000 + 1.5 * HOUR);
      }
    });

    it("drops the window on the way to a category axis", async () => {
      const wrapper = render();
      const chart = last();
      zoomIn(chart);
      await nextTick();

      await wrapper.setProps({ frame: categorical() });
      for (const zoom of dataZooms(lastCall(chart)[0])) {
        expect(zoom.startValue).toBeUndefined();
        expect(zoom.endValue).toBeUndefined();
      }
    });

    it("drops a window the new axis does not reach", async () => {
      // A monthly frame after a zoom into one day of an hourly one, left
      // unclipped, had ECharts clamped to an edge with the reset button on.
      const wrapper = render();
      const chart = last();
      zoomIn(chart);
      await nextTick();
      const elsewhere = frame({ variable: "flow_in", index: [0, 1].map((i) => 1_204_537_600_000 + i * HOUR) });

      await wrapper.setProps({ frame: elsewhere });
      for (const zoom of dataZooms(lastCall(chart)[0])) {
        expect(zoom.startValue).toBeUndefined();
      }
      expect(wrapper.find('[data-testid="zoom-reset"]').exists()).toBe(false);
    });

    it("shows the reset only while zoomed, and resets through the action", async () => {
      const wrapper = render();
      const chart = last();
      expect(wrapper.find('[data-testid="zoom-reset"]').exists()).toBe(false);

      zoomIn(chart);
      await nextTick();
      const reset = wrapper.find('[data-testid="zoom-reset"]');
      expect(reset.exists()).toBe(true);

      await reset.trigger("click");
      expect(chart.dispatchAction).toHaveBeenCalledWith({ type: "dataZoom", start: 0, end: 100 });
      // The action raises the event that clears the window, as a drag home would.
      chart.fire("datazoom", { start: 0, end: 100 });
      await nextTick();
      expect(wrapper.find('[data-testid="zoom-reset"]').exists()).toBe(false);
    });
  });

  describe("hover", () => {
    const pointAt = (chart: Recorder, value: number) =>
      chart.fire("updateAxisPointer", { axesInfo: [{ axisDim: "x", value }] });

    it("emits each category once, and null when the pointer leaves", async () => {
      const wrapper = render({ frame: categorical() });
      const chart = last();
      pointAt(chart, 1);
      pointAt(chart, 1);
      pointAt(chart, 2);
      chart.fire("updateAxisPointer", { axesInfo: [] });

      expect(wrapper.emitted("hoverIndex")).toEqual([["region2"], ["region3"], [null]]);
    });

    it("emits nothing for a time axis", () => {
      const wrapper = render();
      pointAt(last(), 1);
      expect(wrapper.emitted("hoverIndex")).toBeUndefined();
    });

    it("clears on a frame change and on unmount", async () => {
      const wrapper = render({ frame: categorical() });
      pointAt(last(), 0);
      await wrapper.setProps({ frame: categorical() });
      expect(wrapper.emitted("hoverIndex")).toEqual([["region1"], [null]]);

      pointAt(last(), 2);
      expect(wrapper.emitted("hoverIndex")).toEqual([["region1"], [null], ["region3"]]);
      // `emitted()` starts afresh once the instance is gone, so only the
      // unmount's own emission is visible after it.
      wrapper.unmount();
      expect(wrapper.emitted("hoverIndex")).toEqual([[null]]);
    });
  });

  describe("lifecycle", () => {
    const charts = () => (window as unknown as { __cgCharts?: Record<string, unknown> }).__cgCharts;

    it("registers the instance by name, repoints it on a theme change and removes it on unmount", async () => {
      const wrapper = render({ name: "totals" });
      const first = last();
      expect(charts()?.totals).toBe(first);

      useUiStore().revision += 1;
      await nextTick();
      const second = last();
      expect(second).not.toBe(first);
      expect(first.dispose).toHaveBeenCalled();
      expect(charts()?.totals).toBe(second);
      // A fresh instance starts from nothing: the first draw on it must replace.
      expect(lastCall(second)[1].notMerge).toBe(true);

      wrapper.unmount();
      expect(second.dispose).toHaveBeenCalled();
      expect(charts()?.totals).toBeUndefined();
    });

    it("clears the chart and says so when the selection is empty", async () => {
      const wrapper = render();
      await wrapper.setProps({ frame: frame({ series: [] }) });
      expect(last().clear).toHaveBeenCalled();
      expect(wrapper.text()).toContain("No data for this selection.");
    });

    it("shows the error over everything, and the loading state only before a first frame", async () => {
      const wrapper = render({ frame: null, loading: true });
      expect(wrapper.text()).toContain("Reading results");
      await wrapper.setProps({ loading: true, frame: frame() });
      expect(wrapper.text()).not.toContain("Reading results");
      await wrapper.setProps({ error: "boom" });
      expect(wrapper.text()).toContain("boom");
    });
  });
});
