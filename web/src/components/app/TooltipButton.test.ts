import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { h } from "vue";
import { X } from "@lucide/vue";

import TooltipProvider from "@/components/ui/tooltip/TooltipProvider.vue";
import TooltipButton from "./TooltipButton.vue";

/**
 * A disabled icon button still has to be able to say why it is disabled.
 *
 * This is the state where the explanation matters most — `TabHistory`'s Back and
 * Forward are icon-only and spend most of their life dead — and it is the one
 * state a plain tooltip cannot reach: a disabled `<button>` fires no pointer
 * events and takes no focus, so the trigger it hosts never opens. Nothing throws
 * and nothing is logged; the tooltip is simply never seen.
 *
 * So the disabled button is wrapped in a focusable span that carries the
 * trigger, and the button stays a real, disabled button — a caller asking
 * whether the control is available has to keep getting a truthful answer.
 */
function render(props: Record<string, unknown>) {
  return mount(TooltipProvider, {
    slots: {
      default: () => h(TooltipButton, { label: "Go back", icon: X, ...props }),
    },
    global: { stubs: { teleport: true } },
  });
}

const TRIGGER = '[data-slot="tooltip-trigger"]';

describe("TooltipButton", () => {
  it("hosts the trigger on a focusable wrapper when disabled", () => {
    const wrapper = render({ disabled: true });
    const trigger = wrapper.find(TRIGGER);

    expect(trigger.exists()).toBe(true);
    // Not the button: it is disabled, which is the whole problem.
    expect(trigger.element.tagName).toBe("SPAN");
    expect(trigger.attributes("tabindex")).toBe("0");

    const button = wrapper.find("button");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("aria-label")).toBe("Go back");
  });

  it("leaves an enabled button as its own trigger", async () => {
    // The wrapper is deliberately conditional: an unconditional span would take
    // the trigger's props away from every icon button in the app and reparent
    // each one inside a layout that was built around the button itself.
    const wrapper = render({ testid: "tab-back" });
    const trigger = wrapper.find(TRIGGER);

    expect(trigger.element.tagName).toBe("BUTTON");
    expect(trigger.attributes("data-testid")).toBe("tab-back");

    await trigger.trigger("click");
    expect(wrapper.findComponent(TooltipButton).emitted("click")).toHaveLength(1);
  });

  it("keeps the testid on the button in both states", () => {
    // A check that asks whether a control is enabled must find the control, not
    // the wrapper that was added around it.
    const wrapper = render({ testid: "tab-back", disabled: true });
    const tagged = wrapper.find('[data-testid="tab-back"]');
    expect(tagged.element.tagName).toBe("BUTTON");
    expect(tagged.attributes("disabled")).toBeDefined();
  });
});
