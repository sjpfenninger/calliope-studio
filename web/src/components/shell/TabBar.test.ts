import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { h, nextTick } from "vue";

import TooltipProvider from "@/components/ui/tooltip/TooltipProvider.vue";
import TabBar from "./TabBar.vue";
import { useConfirmStore } from "@/stores/confirm";
import { useTabsStore } from "@/stores/tabs";

/**
 * Closing a tab from the keyboard, and the guard that stands in the way.
 *
 * The close control is a `span role="button"` nested inside the tab's own
 * `<button>`, and it cannot take a tabindex without becoming a second tab stop
 * on every tab — so until Delete/Backspace there was no keyboard route to
 * closing a tab at all, only a pointer one.
 *
 * The two assertions that matter are that it goes through `closeGuarded` rather
 * than straight to `closeTab` — a dirty buffer is the only copy of the user's
 * edits, so closing it unasked destroys them — and that the guard's *answer* is
 * honoured in both directions. `stores/confirm` is driven directly here: the
 * dialog itself is rendered by `App.vue`, which is not in this tree.
 */
function render() {
  return mount(TooltipProvider, {
    slots: { default: () => h(TabBar) },
    global: { stubs: { teleport: true } },
  });
}

const tabButton = (wrapper: ReturnType<typeof render>, id: string) =>
  wrapper.find(`[data-tab-id="${id}"]`);

/**
 * `closeGuarded` awaits the dialog, so answering it resumes a continuation a
 * microtask later — one `nextTick` lands before that resumption, not after it.
 */
const settled = async () => {
  await nextTick();
  await nextTick();
};

describe("TabBar", () => {
  let tabs: ReturnType<typeof useTabsStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    tabs = useTabsStore();
    tabs.setVersion("ws1");
  });

  it("closes the focused tab on Delete", async () => {
    const id = tabs.openFile("model.yaml");
    tabs.openFile("techs.yaml");
    const wrapper = render();

    await tabButton(wrapper, id).trigger("keydown", { key: "Delete" });
    await nextTick();

    expect(tabs.has(id)).toBe(false);
    expect(tabs.ordered).toHaveLength(1);
  });

  it("closes on Backspace too", async () => {
    // Which key "delete" is depends on the keyboard, and the user should not
    // have to know which one this app decided on.
    const id = tabs.openFile("model.yaml");
    const wrapper = render();

    await tabButton(wrapper, id).trigger("keydown", { key: "Backspace" });
    await nextTick();

    expect(tabs.has(id)).toBe(false);
  });

  it("leaves every other key to the tab", async () => {
    const id = tabs.openFile("model.yaml");
    const wrapper = render();

    await tabButton(wrapper, id).trigger("keydown", { key: "Enter" });
    await tabButton(wrapper, id).trigger("keydown", { key: "d" });
    await nextTick();

    expect(tabs.has(id)).toBe(true);
  });

  it("asks before closing a dirty tab, and keeps it if the answer is no", async () => {
    const id = tabs.openFile("model.yaml");
    tabs.markDirty(id, "raw");
    const confirm = useConfirmStore();
    const wrapper = render();

    await tabButton(wrapper, id).trigger("keydown", { key: "Delete" });
    await nextTick();

    expect(confirm.request).not.toBeNull();
    expect(tabs.has(id)).toBe(true);

    confirm.answer(false);
    await settled();
    expect(tabs.has(id)).toBe(true);

    // And the same question answered the other way does close it, so the guard
    // is a question rather than a refusal.
    await tabButton(wrapper, id).trigger("keydown", { key: "Delete" });
    await nextTick();
    confirm.answer(true);
    await settled();
    expect(tabs.has(id)).toBe(false);
  });

  it("gives the close control an accessible name", () => {
    // It is an X glyph with no text, so without this it is announced as
    // "button" — and it is the only pointer route to closing a tab.
    const id = tabs.openFile("model.yaml");
    const wrapper = render();
    const close = tabButton(wrapper, id).find('[aria-label="Close tab"]');
    expect(close.exists()).toBe(true);
  });
});
