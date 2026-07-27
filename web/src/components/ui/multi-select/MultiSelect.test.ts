import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import MultiSelect from "./MultiSelect.vue";

/**
 * The trigger's summarising behaviour, which is the whole reason this exists.
 *
 * shadcn-vue has no multi-select, and the filter sidebar needs one that stays a
 * single 28px row whether two technologies are chosen or forty. The popover
 * contents are Reka's Command, tested upstream; what is worth pinning here is
 * the collapse-to-a-count and the clear affordance.
 */
function render(props: Record<string, unknown> = {}) {
  return mount(MultiSelect, {
    props: { options: ["ccgt", "csp", "battery", "pv", "wind"], ...props },
    global: { stubs: { teleport: true } },
  });
}

/** Names the length of `examples/model_nld-NUTS3-v1`'s transmission techs. */
const LONG = ["NLD124_1_maritime_to_NLD124_1", "NLD321_2_maritime_to_NLD321_2"];

describe("MultiSelect", () => {
  it("shows the placeholder when nothing is chosen", () => {
    expect(render({ placeholder: "All technologies" }).text()).toContain(
      "All technologies",
    );
  });

  it("names a small selection", () => {
    const text = render({ modelValue: ["ccgt", "csp"] }).text();
    expect(text).toContain("ccgt");
    expect(text).toContain("csp");
  });

  it("collapses a large selection to a count", () => {
    // Otherwise a model with forty technologies turns a one-line control into a
    // paragraph and the layout gives way.
    const text = render({ modelValue: ["ccgt", "csp", "battery", "pv"] }).text();
    expect(text).toContain("ccgt");
    expect(text).toContain("+2");
    expect(text).not.toContain("pv");
  });

  it("honours a different visible limit", () => {
    const text = render({
      modelValue: ["ccgt", "csp", "battery", "pv"],
      maxVisible: 3,
    }).text();
    expect(text).toContain("+1");
  });

  it("says so when everything is chosen", () => {
    // The state the filter sidebar opens in, since a run selects everything on
    // load. Naming two of five is both longer and less use than the count.
    const text = render({
      modelValue: ["ccgt", "csp", "battery", "pv", "wind"],
    }).text();
    expect(text).toContain("All 5");
    expect(text).not.toContain("ccgt");
  });

  it("gives one long name the row to itself", () => {
    // Two 29-character link names do not fit a 208px sidebar at any truncation
    // worth reading, so the second becomes part of the count.
    const wrapper = render({
      options: [...LONG, "ccgt", "csp"],
      modelValue: LONG,
    });
    const text = wrapper.text();
    expect(text).toContain(LONG[0]);
    expect(text).not.toContain(LONG[1]);
    expect(text).toContain("+1");
  });

  it("still names two short values", () => {
    // The budget must not have quietly cost the ordinary case.
    const text = render({ modelValue: ["ccgt", "csp"] }).text();
    expect(text).toContain("ccgt");
    expect(text).toContain("csp");
    expect(text).not.toContain("+");
  });

  it("shows a label in place of the value it stands for", () => {
    const wrapper = render({
      options: ["r1_to_r2", "ccgt", "csp"],
      modelValue: ["r1_to_r2"],
      labels: { r1_to_r2: "r1 → r2" },
    });
    expect(wrapper.text()).toContain("r1 → r2");
    expect(wrapper.text()).not.toContain("r1_to_r2");
  });

  it("falls back to the value where no label is given", () => {
    // A partly-populated map is normal: a link whose ends the model does not
    // state has no label, and must still be namable.
    const wrapper = render({
      options: ["r1_to_r2", "mystery", "ccgt"],
      modelValue: ["mystery"],
      labels: { r1_to_r2: "r1 → r2" },
    });
    expect(wrapper.text()).toContain("mystery");
  });

  it("offers a clear control only when something is chosen", () => {
    expect(render().find('[aria-label^="Clear"]').exists()).toBe(false);
    expect(
      render({ modelValue: ["ccgt"] }).find('[aria-label^="Clear"]').exists(),
    ).toBe(true);
  });

  it("clears the selection without opening the popover", async () => {
    const wrapper = render({ modelValue: ["ccgt", "csp"] });
    await wrapper.find('[aria-label^="Clear"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([[]]);
  });

  it("is a combobox, so assistive technology announces it as one", () => {
    expect(render().find('[role="combobox"]').exists()).toBe(true);
  });
});
