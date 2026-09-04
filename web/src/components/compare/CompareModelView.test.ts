import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompareModel, CompareSide, DiffEntity, ModelDiff } from "@/api/compare";
import CompareModelView from "./CompareModelView.vue";

/**
 * What the two versions mean, as the user reads it.
 *
 * Every number here is an answer about the model, so the failure that matters
 * is a plausible wrong one: a series summarised as "3 of 8760 changed" when it
 * was 30, a listing on an added technology rendered as a change from nothing,
 * a config difference not shown at all. `compare-check` reaches the entity rows
 * but never expands one, and the example model's comparison produces no series
 * change and no config change at all — so none of this is reachable from a
 * browser check without inventing a model that produces it.
 */
function side(over: Partial<CompareSide> = {}): CompareSide {
  return {
    ref: "workspace",
    kind: "workspace",
    label: "the model",
    scenario: null,
    scenario_known: true,
    model: { source: "resolved" },
    ...over,
  };
}

function diff(over: Partial<ModelDiff> = {}): ModelDiff {
  return { entities: [], config: [], dims: [], summary: {}, empty: false, ...over };
}

function payload(over: Partial<CompareModel> = {}): CompareModel {
  return { a: side(), b: side(), available: true, pending: false, ...over };
}

function render(model: CompareModel | null, props: Record<string, unknown> = {}) {
  return mount(CompareModelView, {
    props: { payload: model, loading: false, error: null, ...props },
  });
}

const changed = (changes: DiffEntity["changes"]): DiffEntity => ({
  kind: "tech",
  name: "ccgt",
  status: "changed",
  changes,
});

const rowFor = (wrapper: ReturnType<typeof render>, param: string) =>
  wrapper.find(`[data-testid="compare-change"][data-param="${param}"]`);

enableAutoUnmount(afterEach);

beforeEach(() => setActivePinia(createPinia()));

describe("CompareModelView", () => {
  describe("a time-varying parameter", () => {
    it("counts the timesteps that changed and sums both sides", () => {
      const wrapper = render(
        payload({
          diff: diff({
            entities: [
              changed([
                {
                  param: "sink_use_equals",
                  where: { nodes: "region1" },
                  unit: "energy",
                  series: { changed: 3, total: 8760, before_sum: 1234, after_sum: 5678 },
                },
              ]),
            ],
          }),
        }),
      );

      const text = rowFor(wrapper, "sink_use_equals").text();
      expect(text).toContain("3 of 8,760 timesteps changed");
      // Sums are compacted where single values are not: nobody matches a sum
      // over 8,760 timesteps against a line in a file.
      expect(text).toContain("→");
      expect(text).toMatch(/1\.23K/);
      expect(text).toMatch(/5\.68K/);
    });

    it("states the window alone when there is nothing to compare it against", () => {
      // An added entity's series is a listing, not a change, so `changed` is
      // absent and a "0 of N changed" would be a claim nobody made.
      const wrapper = render(
        payload({
          diff: diff({
            entities: [
              {
                kind: "tech",
                name: "new_tech",
                status: "added",
                changes: [
                  {
                    param: "sink_use_equals",
                    where: {},
                    unit: "energy",
                    series: { total: 48, before_sum: null, after_sum: 99 },
                  },
                ],
              },
            ],
          }),
        }),
      );

      const text = rowFor(wrapper, "sink_use_equals").text();
      expect(text).toContain("48 timesteps");
      expect(text).not.toContain("changed");
      expect(text).toContain("99");
    });

    it("names the window with no sums when neither side has one", () => {
      const wrapper = render(
        payload({
          diff: diff({
            entities: [
              changed([
                { param: "flow", where: {}, unit: "", series: { changed: 2, total: 24 } },
              ]),
            ],
          }),
        }),
      );

      expect(rowFor(wrapper, "flow").text()).toContain("2 of 24 timesteps changed");
      expect(rowFor(wrapper, "flow").text()).not.toContain("Σ");
    });
  });

  describe("a scalar parameter", () => {
    it("shows both values, unscaled and verbatim", () => {
      // Unscaled deliberately: the number has to be the one in the YAML the
      // Files half shows two clicks away, so `formatCompact` is wrong here.
      const wrapper = render(
        payload({
          diff: diff({
            entities: [
              changed([
                { param: "flow_cap_max", where: {}, unit: "power", before: 12345, after: 20000 },
              ]),
            ],
          }),
        }),
      );

      const text = rowFor(wrapper, "flow_cap_max").text();
      expect(text).toContain("12345");
      expect(text).toContain("20000");
      expect(text).not.toContain("12.3K");
    });

    it("lists what an added entity is, with no arrow", () => {
      // "→ 10000" would invite the question of what it was before, which is
      // nothing.
      const wrapper = render(
        payload({
          diff: diff({
            entities: [
              {
                kind: "tech",
                name: "battery",
                status: "added",
                changes: [{ param: "flow_cap_max", where: {}, unit: "power", after: 10000 }],
              },
            ],
          }),
        }),
      );

      expect(wrapper.text()).toContain("Defined as");
      expect(rowFor(wrapper, "flow_cap_max").text()).not.toContain("→");
      expect(rowFor(wrapper, "flow_cap_max").text()).toContain("10000");
    });

    it("describes a removed entity from the side it was on", () => {
      const wrapper = render(
        payload({
          diff: diff({
            entities: [
              {
                kind: "tech",
                name: "battery",
                status: "removed",
                changes: [{ param: "flow_cap_max", where: {}, unit: "power", before: 10000 }],
              },
            ],
          }),
        }),
      );

      expect(wrapper.text()).toContain("Was defined as");
      expect(rowFor(wrapper, "flow_cap_max").text()).toContain("10000");
    });

    it.each([
      [null, "—"],
      [undefined, "—"],
      [[], "—"],
      [["a", "b"], "a, b"],
    ])("renders %s as %s", (value, shown) => {
      const wrapper = render(
        payload({
          diff: diff({
            entities: [
              changed([{ param: "carrier_in", where: {}, unit: "", before: value, after: 1 }]),
            ],
          }),
        }),
      );

      expect(rowFor(wrapper, "carrier_in").text()).toContain(shown);
    });

    it("says how many further changes it did not list", () => {
      const wrapper = render(
        payload({
          diff: diff({
            entities: [
              { ...changed([{ param: "a", where: {}, unit: "", before: 1, after: 2 }]), truncated: 7 },
            ],
          }),
        }),
      );

      expect(wrapper.text()).toContain("7 further changes");
    });
  });

  describe("the model as a whole", () => {
    it("shows a config difference by its dotted path", () => {
      // Reachable from no browser check: the example model's two versions
      // never differ in config.
      const wrapper = render(
        payload({
          diff: diff({
            config: [{ path: "build.ensure_feasibility", before: true, after: false }],
          }),
        }),
      );

      const section = wrapper.find('[data-testid="compare-config"]');
      expect(section.exists()).toBe(true);
      expect(rowFor(wrapper, "build.ensure_feasibility").text()).toContain("true");
      expect(rowFor(wrapper, "build.ensure_feasibility").text()).toContain("false");
    });

    it("states a changed time window once, not on every series", () => {
      const wrapper = render(
        payload({
          diff: diff({
            dims: [
              { dim: "timesteps", before: 8760, after: 48 },
              { dim: "nodes", before: 3, after: 4, added: ["region4"], removed: [] },
            ],
          }),
        }),
      );

      const dims = wrapper.find('[data-testid="compare-dims"]');
      expect(dims.text()).toContain("timesteps");
      expect(dims.text()).toContain("8760");
      expect(dims.text()).toContain("region4");
    });

    it("says so plainly when the two versions agree", () => {
      const wrapper = render(payload({ diff: diff({ empty: true }) }));
      expect(wrapper.find('[data-testid="compare-model-empty"]').exists()).toBe(true);
    });
  });

  describe("before there is a diff", () => {
    it("shows the error above everything else", () => {
      const wrapper = render(null, { error: "could not compare" });
      expect(wrapper.text()).toContain("could not compare");
    });

    it("says a side cannot be read, and which one", () => {
      const wrapper = render(
        payload({
          available: false,
          b: side({ kind: "run", label: "Tuesday", model: { source: "unavailable", reason: "no results" } }),
        }),
      );

      const status = wrapper.find('[data-testid="compare-model-status"]');
      expect(status.text()).toContain("run");
      expect(status.text()).toContain("no results");
    });

    it("stops claiming to be working once the store has given up", () => {
      const wrapper = render(payload({ available: false, pending: true }), { gaveUp: true });
      const status = wrapper.find('[data-testid="compare-model-status"]');
      expect(status.text()).toContain("Refresh");
    });
  });
});
