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
    props: { options: ["ccgt", "csp", "battery", "pv"], ...props },
    global: { stubs: { teleport: true } },
  });
}

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
