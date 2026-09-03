import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { h } from "vue";

import TooltipProvider from "@/components/ui/tooltip/TooltipProvider.vue";
import ScalarOrDataVar from "./ScalarOrDataVar.vue";

/**
 * The shape a value arrived in is the shape it leaves in.
 *
 * This is where two of Calliope's own example values were being rewritten:
 * `carrier_out: [electricity, heat]` went back as the string `electricity,heat`
 * after any edit, and an indexed parameter's `data: [100, 200]` came back as
 * `['100', '200']` the moment any of its three fields was touched. Both are
 * wrong values presented as edits the user made.
 */
function edit(value: unknown) {
  const emitted: unknown[] = [];
  const wrapper = mount(TooltipProvider, {
    slots: {
      default: () =>
        h(ScalarOrDataVar, {
          modelValue: value,
          "onUpdate:modelValue": (next: unknown) => emitted.push(next),
        }),
    },
  });
  return { wrapper, emitted };
}

async function type(wrapper: ReturnType<typeof edit>["wrapper"], at: number, text: string) {
  // `setValue` fires `input` and `change` itself; the component commits on `change`.
  await wrapper.findAll("input")[at]!.setValue(text);
}

describe("ScalarOrDataVar", () => {
  it("shows a list comma-separated and writes it back as a list", async () => {
    const { wrapper, emitted } = edit(["electricity", "heat"]);
    expect(wrapper.find("input").element.value).toBe("electricity, heat");

    await type(wrapper, 0, "electricity, heat, cooling");
    expect(emitted).toEqual([["electricity", "heat", "cooling"]]);
  });

  it("keeps a scalar a scalar", async () => {
    const { wrapper, emitted } = edit(100);
    await type(wrapper, 0, "250");
    expect(emitted).toEqual([250]);
  });

  it("keeps the numbers in an indexed parameter numeric", async () => {
    const { wrapper, emitted } = edit({ data: [100, 200], index: ["a", "b"], dims: "costs" });
    await type(wrapper, 0, "100, 300");
    expect(emitted).toEqual([{ data: [100, 300], index: ["a", "b"], dims: "costs" }]);
  });

  it("does not add a dims key the value never had", async () => {
    const { wrapper, emitted } = edit({ data: [1, 2], index: ["x", "y"] });
    await type(wrapper, 1, "x, z");
    expect(emitted).toEqual([{ data: [1, 2], index: ["x", "z"] }]);
  });
});
