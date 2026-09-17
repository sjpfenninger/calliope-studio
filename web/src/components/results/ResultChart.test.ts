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

  describe("a window across a streaming frame", () => {
    // A year of hours arrives in three batches. The replace happens on the
    // first, whose axis ends in June, and clipping the window to *that* and
    // keeping it cut every zoom past June down to the batch's last hour.
    const at = (hour: number) => 1_104_537_600_000 + hour * HOUR;
    const hours = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => at(from + i));
    const partial = (variable: string, count: number) =>
      frame({
        variable,
        index: hours(0, count),
        series: [{ key: "ccgt", values: new Float64Array(count).fill(1), dims: { techs: "ccgt" } }],
      });
    /** Zoomed to hours 6–9 of a twelve-hour frame. */
    async function zoomedOnTwelveHours() {
      const wrapper = render({ frame: partial("flow_out", 12), window: null });
      const chart = last();
      chart.fire("datazoom", { start: 50, end: 75 });
      await nextTick();
      expect(wrapper.emitted("update:window")?.at(-1)).toEqual([
        { startValue: at(5.5), endValue: at(8.25) },
      ]);
      return { wrapper, chart };
    }

    it("re-applies the reader's window on each batch and settles on the whole frame", async () => {
      const { wrapper, chart } = await zoomedOnTwelveHours();
      const window = { startValue: at(5.5), endValue: at(8.25) };

      // The first batch of the next variable reaches only hour 6.
      await wrapper.setProps({ loading: true, frame: partial("flow_in", 7) });
      let [option, flags] = lastCall(chart);
      expect(flags.notMerge).toBe(true);
      expect(dataZooms(option)[0]).toMatchObject({ startValue: at(5.5), endValue: at(6) });
      // Clipped on the chart, but not reported as the reader's choice.
      expect(wrapper.emitted("update:window")?.length).toBe(1);

      // The second batch: a merge, and the window grows with the axis.
      await wrapper.setProps({ frame: partial("flow_in", 12) });
      [option, flags] = lastCall(chart);
      expect(flags.notMerge).toBe(false);
      expect(dataZooms(option)[0]).toMatchObject(window);

      // The stream ends: judged once against the whole frame, through the
      // action, and the event it raises reports it.
      chart.getOption.mockReturnValue({ dataZoom: [{ startValue: at(5.5), endValue: at(8.25) }] });
      await wrapper.setProps({ loading: false });
      expect(chart.dispatchAction).not.toHaveBeenCalled();
      expect(wrapper.emitted("update:window")?.length).toBe(1);
    });

    it("clips a window the complete frame genuinely does not reach", async () => {
      const { wrapper, chart } = await zoomedOnTwelveHours();

      await wrapper.setProps({ loading: true, frame: partial("flow_in", 7) });
      chart.getOption.mockReturnValue({ dataZoom: [{ startValue: at(5.5), endValue: at(6) }] });
      await wrapper.setProps({ loading: false });
      expect(chart.dispatchAction).toHaveBeenCalledWith({
        type: "dataZoom",
        dataZoomIndex: 0,
        startValue: at(5.5),
        endValue: at(6),
      });
      // The action's event is what the boxes hear, exactly as after a drag.
      chart.fire("datazoom", { start: (5.5 / 6) * 100, end: 100 });
      await nextTick();
      expect(wrapper.emitted("update:window")?.at(-1)).toEqual([{ startValue: at(5.5), endValue: at(6) }]);
    });

    it("drops a window the complete frame misses", async () => {
      const { wrapper, chart } = await zoomedOnTwelveHours();
      // The parent holds what was reported, as `v-model:window` would.
      await wrapper.setProps({ window: { startValue: at(5.5), endValue: at(8.25) } });

      await wrapper.setProps({ loading: true, frame: partial("flow_in", 3) });
      expect(dataZooms(lastCall(chart)[0])[0].startValue).toBeUndefined();
      await wrapper.setProps({ loading: false });
      // Nothing was zoomed on the chart, so no action; the intent is let go.
      expect(chart.dispatchAction).not.toHaveBeenCalled();
      expect(wrapper.emitted("update:window")?.at(-1)).toEqual([null]);
    });

    it("lets a drag mid-stream win over the carried window", async () => {
      const { wrapper, chart } = await zoomedOnTwelveHours();

      await wrapper.setProps({ loading: true, frame: partial("flow_in", 6) });
      chart.fire("datazoom", { start: 0, end: 40 });
      await nextTick();
      await wrapper.setProps({ frame: partial("flow_in", 12) });
      expect(dataZooms(lastCall(chart)[0])[0]).toMatchObject({ startValue: at(0), endValue: at(2) });
    });
  });

  describe("time axis", () => {
    it("draws in UTC, so a timestep sits where the table and the CSV put it", () => {
      // The default frame is hourly on a time axis. ECharts formats a time axis
      // in the browser's zone unless told otherwise, and a 13:00 timestep drawn
      // at 15:00 for a reader in Zürich contradicts the table beside it.
      render();
      const [option] = lastCall(last());
      expect(option.useUTC).toBe(true);
    });

    it("names the month on a year tick, so a January bar is not labelled '2020'", () => {
      // The January tick of a monthly chart is a year boundary, and ECharts'
      // own template for those is the bare year: twelve bars read "2020, Feb,
      // Mar, …". Every other unit keeps its default, and each keeps the bold
      // second level ECharts would otherwise drop once any unit is named.
      render();
      const [option] = lastCall(last());
      const formatter = (option.xAxis as { axisLabel: { formatter: Record<string, string[]> } })
        .axisLabel.formatter;
      expect(formatter.year).toEqual(["{MMM} {yyyy}", "{primary|{MMM} {yyyy}}"]);
      expect(formatter.month).toEqual(["{MMM}", "{primary|{MMM}}"]);
      expect(formatter.day[0]).toBe("{d}");
      expect(formatter.hour[0]).toBe("{HH}:{mm}");
      expect(Object.keys(formatter)).toEqual([
        "year",
        "month",
        "day",
        "hour",
        "minute",
        "second",
        "millisecond",
      ]);
    });
  });

  describe("overlay", () => {
    const price = (overrides: Partial<ResultFrame> = {}) =>
      frame({
        variable: "shadow_price_system_balance",
        series: [{ key: "power", values: Float64Array.from([4, 4, 3, 0]), dims: { carriers: "power" } }],
        seriesDims: ["carriers"],
        ...overrides,
      });
    const series = (option: Record<string, unknown>) => option.series as Array<Record<string, unknown>>;
    const axes = (option: Record<string, unknown>) => option.yAxis as Array<Record<string, unknown>>;

    it("draws the overlay as unstacked lines on a second, right-hand axis", () => {
      render({ overlayFrame: price(), overlayUnit: { label: "EUR", factor: 1 } });
      const [option] = lastCall(last());
      expect(axes(option)).toHaveLength(2);
      expect(axes(option)[1]).toMatchObject({ position: "right", name: "EUR" });
      const line = series(option).find((entry) => entry.yAxisIndex === 1)!;
      expect(line).toMatchObject({ type: "line", name: "shadow_price_system_balance | power" });
      expect(line.stack).toBeUndefined();
      // The main series stay on the first axis, stacked as before.
      expect(series(option)[0]).toMatchObject({ type: "bar", stack: "total" });
      expect(series(option)[0].yAxisIndex).toBeUndefined();
    });

    it("has one axis and no extra series without an overlay, or with an empty one", async () => {
      const wrapper = render();
      expect(axes(lastCall(last())[0])).toHaveLength(1);
      await wrapper.setProps({ overlayFrame: price({ series: [] }) });
      expect(axes(lastCall(last())[0])).toHaveLength(1);
      expect(series(lastCall(last())[0])).toHaveLength(1);
    });

    it("leaves the overlay off a category axis", () => {
      render({ frame: categorical(), overlayFrame: price() });
      const [option] = lastCall(last());
      expect(axes(option)).toHaveLength(1);
      expect(series(option)).toHaveLength(1);
    });

    it.each([
      ["arrives", {}, { overlayFrame: price() }],
      ["goes", { overlayFrame: price() }, { overlayFrame: null }],
      ["changes variable", { overlayFrame: price() }, { overlayFrame: price({ variable: "flow_in" }) }],
      ["changes unit", { overlayFrame: price(), overlayUnit: { label: "EUR", factor: 1 } }, { overlayUnit: { label: "kEUR", factor: 0.001 } }],
    ])("replaces when the overlay %s, since a merge never removes an axis or a series", async (_, initial, next) => {
      const wrapper = render(initial);
      await wrapper.setProps(next);
      expect(lastCall(last())[1].notMerge).toBe(true);
    });

    it("carries the zoom window across the overlay arriving", async () => {
      const wrapper = render();
      const chart = last();
      chart.fire("datazoom", { start: 25, end: 50 });
      await nextTick();

      await wrapper.setProps({ overlayFrame: price() });
      for (const zoom of dataZooms(lastCall(chart)[0])) {
        expect(zoom.startValue).toBe(1_104_537_600_000 + 0.75 * HOUR);
        expect(zoom.endValue).toBe(1_104_537_600_000 + 1.5 * HOUR);
      }
    });

    it("gives an uncoloured overlay the foreground ink and a coloured one its colour", () => {
      render({
        overlayFrame: price({
          series: [
            { key: "a", values: Float64Array.from([1, 1, 1, 1]), dims: { techs: "a" } },
            { key: "b", values: Float64Array.from([2, 2, 2, 2]), dims: { techs: "b" }, color: "#ff0000" },
          ],
          seriesDims: ["techs"],
        }),
      });
      const lines = series(lastCall(last())[0]).filter((entry) => entry.yAxisIndex === 1);
      expect((lines[0]!.itemStyle as { color: string }).color).not.toBe("#ff0000");
      expect((lines[1]!.itemStyle as { color: string }).color).toBe("#ff0000");
      expect((lines[1]!.lineStyle as { type: string }).type).toBe("solid");
    });
  });

  describe("controlled window", () => {
    const T0 = 1_104_537_600_000;
    const week = { startValue: T0 + HOUR, endValue: T0 + 2 * HOUR };
    const lastAction = (chart: Recorder) =>
      chart.dispatchAction.mock.calls[chart.dispatchAction.mock.calls.length - 1]?.[0];

    it("applies a window it is handed through the action, and a null as a reset", async () => {
      const wrapper = render({ window: null });
      const chart = last();
      await wrapper.setProps({ window: week });
      expect(lastAction(chart)).toMatchObject({ type: "dataZoom", ...week });

      chart.fire("datazoom", week);
      await wrapper.setProps({ window: null });
      expect(lastAction(chart)).toMatchObject({ type: "dataZoom", start: 0, end: 100 });
    });

    it("clips a window to the axis before applying it", async () => {
      const wrapper = render({ window: null });
      await wrapper.setProps({ window: { startValue: T0 + HOUR, endValue: T0 + 40 * HOUR } });
      expect(lastAction(last())).toMatchObject({ startValue: T0 + HOUR, endValue: T0 + 3 * HOUR });
    });

    it("reports a drag back, and says nothing for a window it already holds", async () => {
      const wrapper = render({ window: null });
      const chart = last();
      chart.fire("datazoom", week);
      expect(wrapper.emitted("update:window")?.at(-1)).toEqual([week]);

      await wrapper.setProps({ window: week });
      expect(chart.dispatchAction).not.toHaveBeenCalled();
    });

    it("reports the window dropped on the way to a category axis", async () => {
      const wrapper = render({ window: null });
      last().fire("datazoom", week);
      await wrapper.setProps({ window: week, frame: categorical() });
      expect(wrapper.emitted("update:window")?.at(-1)).toEqual([null]);
    });

    it("starts where the caller says when drawn fresh under a window", () => {
      render({ window: week });
      for (const zoom of dataZooms(lastCall(last())[0])) {
        expect(zoom.startValue).toBe(week.startValue);
        expect(zoom.endValue).toBe(week.endValue);
      }
    });

    it("keeps its own window, and tells nobody, when not controlled", () => {
      const wrapper = render();
      last().fire("datazoom", week);
      expect(wrapper.emitted("update:window")).toBeUndefined();
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
