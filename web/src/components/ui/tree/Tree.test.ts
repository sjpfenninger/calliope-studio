import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import Tree from "./Tree.vue";

/**
 * The two custom UI components — this and MultiSelect — are the only ones in
 * `ui/` that shadcn-vue did not generate, so they are the only ones worth
 * testing here. Reka's tree primitive is also newer than the rest of the
 * library, and this pins the parts both explorer trees rely on.
 */

interface TreeNode extends Record<string, unknown> {
  key: string;
  label: string;
  children?: TreeNode[];
}

const items: TreeNode[] = [
  {
    key: "techs",
    label: "techs",
    children: [
      { key: "techs:ccgt", label: "ccgt" },
      { key: "techs:csp", label: "csp" },
    ],
  },
  { key: "nodes", label: "nodes", children: [{ key: "nodes:region1", label: "region1" }] },
];

// Typed against the erased item type: `mount()` cannot infer the component's
// generic from a props object, so accessors written against `TreeNode` would be
// rejected as too narrow for the parameter position.
const getKey = (item: Record<string, any>) => item.key as string;
const getChildren = (item: Record<string, any>) =>
  item.children as Record<string, any>[] | undefined;
const getLabel = (item: Record<string, any>) => item.label as string;

function render(props: Record<string, unknown> = {}) {
  return mount(Tree, {
    props: { items, getKey, getChildren, getLabel, ...props },
  });
}

describe("Tree", () => {
  it("renders the roots collapsed", () => {
    const text = render().text();
    expect(text).toContain("techs");
    expect(text).toContain("nodes");
    // Children stay hidden until their parent is expanded, which is what makes
    // a large model's tree usable at all.
    expect(text).not.toContain("ccgt");
  });

  it("shows children of an expanded branch", () => {
    const text = render({ expanded: ["techs"] }).text();
    expect(text).toContain("ccgt");
    expect(text).toContain("csp");
    expect(text).not.toContain("region1");
  });

  it("indents by level, starting the roots flush", () => {
    // Reka counts levels from 1, so a naive `level * step` leaves every root
    // indented from nothing.
    const rows = render({ expanded: ["techs"] }).findAll('[role="treeitem"]');
    const padding = (index: number) =>
      (rows[index].attributes("style") ?? "").match(/padding-left:\s*(\d+)px/)?.[1];
    expect(padding(0)).toBe("0");
    expect(padding(1)).toBe("12");
  });

  it("falls back to the key when no label accessor is given", () => {
    const wrapper = mount(Tree, { props: { items, getKey } });
    expect(wrapper.text()).toContain("techs");
  });

  it("marks the selected item, so styling can key off it", async () => {
    const wrapper = render({ expanded: ["techs"], modelValue: items[0].children![0] });
    await wrapper.vm.$nextTick();
    expect(wrapper.html()).toContain("data-selected");
  });

  it("gives every row a treeitem role", () => {
    expect(render().findAll('[role="treeitem"]').length).toBe(2);
  });
});
