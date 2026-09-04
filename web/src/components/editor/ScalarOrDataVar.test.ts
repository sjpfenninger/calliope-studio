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

  it("keeps a scalar data value numeric in an indexed parameter", async () => {
    // The shape that actually bit: `cost_flow_cap: {data: 41.0, index: monetary,
    // dims: costs}` typed over as 20 came back as the YAML string '20'.
    const { wrapper, emitted } = edit({ data: 41, index: "monetary", dims: "costs" });
    await type(wrapper, 0, "20");
    expect(emitted).toEqual([{ data: 20, index: "monetary", dims: "costs" }]);
  });

  it("parses index labels like values and dimension names like names", async () => {
    const { wrapper, emitted } = edit({ data: [1, 2], index: [2020, 2030], dims: "years" });
    await type(wrapper, 1, "2020, 2040");
    expect(emitted).toEqual([{ data: [1, 2], index: [2020, 2040], dims: "years" }]);

    await type(wrapper, 2, "2030");
    expect(emitted.at(-1)).toEqual({ data: [1, 2], index: [2020, 2040], dims: "2030" });
  });

  it("does not add a dims key the value never had", async () => {
    const { wrapper, emitted } = edit({ data: [1, 2], index: ["x", "y"] });
    await type(wrapper, 1, "x, z");
    expect(emitted).toEqual([{ data: [1, 2], index: ["x", "z"] }]);
  });
});
