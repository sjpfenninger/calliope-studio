import { mount } from "@vue/test-utils";
import { h } from "vue";
import { describe, expect, it } from "vitest";

import TooltipProvider from "@/components/ui/tooltip/TooltipProvider.vue";
import SchemaObjectEditor, { type FieldOverlay } from "./SchemaObjectEditor.vue";

/**
 * The three things about this form that a pure function cannot state.
 *
 * `lib/schemaWidgets.test.ts` covers what a value *is*; what is left is what the
 * form chooses to show, and it is where the reported bug lived: a model setting
 * `datetime_format` and `shadow_prices` displayed neither, because `hidden: true`
 * in the overlay meant both "not part of this form" and "less commonly used".
 *
 * The promotion rule is also the one thing here that must not be reactive. Were
 * `revealed` derived from the current value, clearing a field would delete its
 * key and collapse the field away under the pointer — so the second test asserts
 * a *negative*: opening the disclosure emits nothing.
 */
const SCHEMA = {
  properties: {
    name: { anyOf: [{ type: "string" }, { type: "null" }] },
    datetime_format: { default: "ISO8601", type: "string" },
    date_format: { default: "ISO8601", type: "string" },
    math_paths: {
      patternProperties: { "^[^_^\\d][\\w]*$": { format: "path", type: "string" } },
      type: "object",
    },
    mode: { default: "base", enum: ["base", "operate", "spores"], type: "string" },
    operate: {
      properties: { window: { default: "24h", type: "string" } },
      type: "object",
    },
  },
};

const OVERLAY: FieldOverlay = {
  datetime_format: { tier: "advanced" },
  date_format: { tier: "advanced" },
  math_paths: { ownedBy: { label: "Math", hint: "Owned by the Math tab." } },
  operate: { tier: "advanced", showIf: { field: "$ctx.mode", eq: "operate" } },
  time_subset: { expected: "Saved as subset.timesteps." },
};

/**
 * Mounted under a `TooltipProvider`, as `App.vue` mounts the whole app.
 *
 * Every label and every icon button here goes through `InfoTip`, and Reka's
 * tooltip injects a context it will not construct for itself — so a bare mount
 * throws before rendering a single row.
 */
function render(modelValue: Record<string, any>, extra: Record<string, unknown> = {}) {
  const host = mount(TooltipProvider, {
    slots: {
      default: () =>
        h(SchemaObjectEditor, {
          schema: SCHEMA,
          modelValue,
          overlay: OVERLAY,
          context: {},
          ...extra,
        }),
    },
    global: { stubs: { teleport: true } },
  });
  return Object.assign(host, { editor: host.findComponent(SchemaObjectEditor) });
}

/** The labels of the rows currently on screen, in order. */
function labels(wrapper: ReturnType<typeof render>): string[] {
  return wrapper.findAll("label").map((el) => el.text());
}

describe("SchemaObjectEditor", () => {
  it("shows an advanced field the object sets, without opening the disclosure", () => {
    // The reported bug, in one line: `examples/model_assignment-2026` sets
    // `datetime_format` and the form said nothing about it.
    const shown = labels(render({ name: "m", datetime_format: "%Y-%m-%d" }));
    expect(shown).toContain("datetime_format");
    expect(shown).not.toContain("date_format");
  });

  it("counts an explicit null as set, because the user wrote it", () => {
    expect(labels(render({ date_format: null }))).toContain("date_format");
  });

  it("hides an unset advanced field until the disclosure is opened", () => {
    expect(labels(render({ name: "m" }))).not.toContain("datetime_format");
    expect(labels(render({ name: "m" }, { showAdvanced: true }))).toContain(
      "datetime_format",
    );
  });

  it("names how many fields the disclosure holds", () => {
    // Three advanced properties: `datetime_format` is set and so promoted out,
    // `operate`'s condition excludes it from the form entirely, and the count
    // names what opening the disclosure would actually reveal.
    expect(render({ datetime_format: "%Y" }).text()).toContain("advanced (1)");
    expect(render({}, { context: { mode: "operate" } }).text()).toContain("advanced (3)");
  });

  it("asks for the disclosure rather than owning it, and writes nothing doing so", () => {
    const wrapper = render({ name: "m" });
    wrapper.findAll("button")[0]!.trigger("click");
    expect(wrapper.editor.emitted("update:showAdvanced")).toEqual([[true]]);
    // The failure this catches: promotion computed off the live value, which
    // makes a re-render able to write. A form must not save by being looked at.
    expect(wrapper.editor.emitted("update:modelValue")).toBeUndefined();
  });

  it("shows a field the object sets even when its condition says otherwise", () => {
    // `operate` is meaningless outside operate mode — which is exactly why a
    // model that sets it anyway needs to be able to see that it did.
    const shown = labels(render({ operate: { window: "48h" } }, { context: { mode: "base" } }));
    expect(shown).toContain("window");
  });

  it("shows a key another surface owns, without a control for it", () => {
    const wrapper = render({ math_paths: { dispatch: "custom-math.yaml" } });
    expect(wrapper.text()).toContain("custom-math.yaml");
    expect(wrapper.text()).toContain("Math");
    // A mapping row would give it an input; `ownedBy` gives it none.
    expect(wrapper.findAll('input[placeholder="key"]')).toHaveLength(0);
  });

  it("carries every key it arrived with through an edit", () => {
    // Including the ones no field renders. The editors above this pass the whole
    // section back to the server, so a key dropped here is a key deleted from
    // the user's file.
    const wrapper = render({ name: "m", time_subset: ["a", "b"], unheard_of: 1 });
    wrapper.find('input[type="text"]').setValue("renamed");
    wrapper.find('input[type="text"]').trigger("change");
    expect(wrapper.editor.emitted("update:modelValue")![0]![0]).toEqual({
      name: "renamed",
      time_subset: ["a", "b"],
      unheard_of: 1,
    });
  });

  it("names a key the schema does not describe, and offers to remove it", () => {
    const wrapper = render({ name: "m", unheard_of: 1 });
    expect(wrapper.text()).toContain("unheard_of");
    expect(wrapper.text()).toContain("unknown");
    const remove = wrapper.find('[aria-label="Remove this key"]');
    remove.trigger("click");
    expect(wrapper.editor.emitted("update:modelValue")![0]![0]).toEqual({ name: "m" });
  });

  it("explains an expected legacy key instead of offering to delete it", () => {
    // Removing `time_subset` would throw the value away; the save migrates it.
    const wrapper = render({ time_subset: ["a", "b"] });
    expect(wrapper.text()).toContain("migrated");
    expect(wrapper.find('[aria-label="Remove this key"]').exists()).toBe(false);
  });

  it("says nothing is unrecognised when the schema never arrived", () => {
    // `stores/schema.ts` swallows a failed fetch and the editors see `{}`.
    const wrapper = mount(SchemaObjectEditor, {
      props: { schema: {}, modelValue: { name: "m", mode: "base" } },
    });
    expect(wrapper.text()).not.toContain("not recognised");
  });

  it("removes a key rather than writing an explicit null when a field is cleared", () => {
    // With twenty more fields on screen, the alternative sprinkles
    // `datetime_format:` into a file the user only looked at.
    const wrapper = render({ name: "m" });
    const input = wrapper.find('input[type="text"]');
    input.setValue("");
    input.trigger("change");
    expect(wrapper.editor.emitted("update:modelValue")![0]![0]).toEqual({});
  });
});
