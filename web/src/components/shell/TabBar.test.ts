import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { h, nextTick } from "vue";

import type { RunRecord, RunStatus } from "@/api/runs";
import TooltipProvider from "@/components/ui/tooltip/TooltipProvider.vue";
import TabBar from "./TabBar.vue";
import { refKey, workspaceRef } from "@/lib/compareRef";
import { useCompareStore } from "@/stores/compare";
import { useConfirmStore } from "@/stores/confirm";
import { useMathStore } from "@/stores/math";
import { useRunsStore } from "@/stores/runs";
import { useTabsStore } from "@/stores/tabs";
import { useValidationStore } from "@/stores/validation";

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

  it("closes on a middle click, and asks first when the tab is dirty", async () => {
    // Middle click is the one close route that does not go through the close
    // glyph, so it is the one that could quietly bypass `closeGuarded` — and a
    // dirty buffer is the only copy of the user's edits.
    const clean = tabs.openFile("model.yaml");
    const dirty = tabs.openFile("techs.yaml");
    tabs.markDirty(dirty, "raw");
    const confirm = useConfirmStore();
    const wrapper = render();

    await tabButton(wrapper, clean).trigger("auxclick", { button: 1 });
    await nextTick();
    expect(tabs.has(clean)).toBe(false);

    await tabButton(wrapper, dirty).trigger("auxclick", { button: 1 });
    await nextTick();
    expect(confirm.request).not.toBeNull();
    expect(tabs.has(dirty)).toBe(true);
    confirm.answer(true);
    await settled();
    expect(tabs.has(dirty)).toBe(false);
  });

  it("ignores a right click, which has its own meaning", async () => {
    const id = tabs.openFile("model.yaml");
    const wrapper = render();

    await tabButton(wrapper, id).trigger("auxclick", { button: 2 });
    await nextTick();

    expect(tabs.has(id)).toBe(true);
  });

  it("closes from the close glyph on Enter and on Space", async () => {
    // `role="button"` promises both, and the glyph is a tab stop of its own —
    // without this it is a control a keyboard can reach and cannot use.
    for (const key of ["Enter", " "]) {
      const id = tabs.openFile(`${key === " " ? "space" : "enter"}.yaml`);
      const wrapper = render();

      await tabButton(wrapper, id)
        .find('[aria-label="Close tab"]')
        .trigger("keydown", { key });
      await nextTick();

      expect(tabs.has(id), key).toBe(false);
      wrapper.unmount();
    }
  });

  it("leaves other keys on the close glyph alone", async () => {
    const id = tabs.openFile("model.yaml");
    const wrapper = render();

    await tabButton(wrapper, id)
      .find('[aria-label="Close tab"]')
      .trigger("keydown", { key: "a" });
    await nextTick();

    expect(tabs.has(id)).toBe(true);
  });

  describe("scrolling the strip", () => {
    /**
     * A mouse has only a vertical wheel, so without this a tab scrolled off the
     * end is unreachable by anything but the keyboard. happy-dom reports every
     * element as zero-sized, so the overflow the handler tests for has to be
     * declared here.
     */
    const strip = (wrapper: ReturnType<typeof render>) =>
      wrapper.find('[data-testid="tab-strip"]').element as HTMLElement;

    const overflowing = (el: HTMLElement, scrollWidth: number, clientWidth: number) => {
      Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true });
      Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true });
      el.scrollLeft = 0;
    };

    it("turns a vertical wheel into horizontal scrolling", async () => {
      const wrapper = render();
      tabs.openFile("model.yaml");
      await nextTick();
      const el = strip(wrapper);
      overflowing(el, 800, 400);

      await wrapper.find('[data-testid="tab-strip"]').trigger("wheel", { deltaY: 120, deltaX: 0 });

      expect(el.scrollLeft).toBe(120);
    });

    it("leaves a trackpad's horizontal delta alone", async () => {
      // The browser already scrolls the strip for that one; taking it over
      // would double every swipe.
      const wrapper = render();
      tabs.openFile("model.yaml");
      await nextTick();
      const el = strip(wrapper);
      overflowing(el, 800, 400);

      await wrapper
        .find('[data-testid="tab-strip"]')
        .trigger("wheel", { deltaY: 10, deltaX: 90 });

      expect(el.scrollLeft).toBe(0);
    });

    it("does nothing when everything already fits", async () => {
      const wrapper = render();
      tabs.openFile("model.yaml");
      await nextTick();
      const el = strip(wrapper);
      overflowing(el, 400, 400);

      await wrapper.find('[data-testid="tab-strip"]').trigger("wheel", { deltaY: 120, deltaX: 0 });

      expect(el.scrollLeft).toBe(0);
    });
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

/**
 * The running indicator.
 *
 * A run, a validation build and a math render all carry on after the user
 * clicks to another tab, and a tab that goes quiet the moment it is left reads
 * as finished — so the user goes back to check, which is the round trip the
 * indicator exists to remove. What these pin is the predicate in each direction:
 * the line shows while the store says the work is going, and *only* then. A
 * false positive is the worse failure, because a line that never goes away says
 * nothing, and a run tab with no record behind it is exactly where one would
 * come from.
 */
describe("TabBar running indicator", () => {
  let tabs: ReturnType<typeof useTabsStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    tabs = useTabsStore();
    tabs.setVersion("ws1");
  });

  const busyOn = (wrapper: ReturnType<typeof render>, id: string) =>
    tabButton(wrapper, id).find('[data-testid="tab-busy"]').exists();

  const record = (status: RunStatus): RunRecord =>
    ({ id: "run-1", label: "Run 1", status, results_handle: null }) as RunRecord;

  it("shows on a compare tab while either half is being fetched", async () => {
    // The one predicate that reads a second store's map through a getter.
    const compare = useCompareStore();
    const a = workspaceRef(null);
    const b = workspaceRef("high_cost");
    const id = tabs.openCompare(a, b);
    const wrapper = render();
    expect(busyOn(wrapper, id)).toBe(false);

    const entry = {
      files: null,
      model: null,
      filesError: null,
      modelError: null,
      loadingFiles: true,
      loadingModel: false,
      resolving: false,
      gaveUp: false,
    };
    compare.entries.set(refKey(a, b), entry);
    await nextTick();
    expect(busyOn(wrapper, id)).toBe(true);

    compare.entries.set(refKey(a, b), { ...entry, loadingFiles: false, resolving: true });
    await nextTick();
    expect(busyOn(wrapper, id)).toBe(true);

    compare.entries.set(refKey(a, b), { ...entry, loadingFiles: false });
    await nextTick();
    expect(busyOn(wrapper, id)).toBe(false);
  });

  it("shows on a run tab while its run is pending or running, and not after", async () => {
    const runs = useRunsStore();
    runs.records.set("run-1", record("pending"));
    const id = tabs.openRun({ id: "run-1" });
    const wrapper = render();

    expect(busyOn(wrapper, id)).toBe(true);
    expect(tabButton(wrapper, id).attributes("data-busy")).toBe("true");
    expect(tabButton(wrapper, id).attributes("title")).toContain("running");

    runs.records.set("run-1", record("running"));
    await nextTick();
    expect(busyOn(wrapper, id)).toBe(true);

    for (const status of ["success", "infeasible", "failed", "cancelled"] as const) {
      runs.records.set("run-1", record(status));
      await nextTick();
      expect(busyOn(wrapper, id), status).toBe(false);
      expect(tabButton(wrapper, id).attributes("data-busy")).toBeUndefined();
    }
  });

  it("never shows on a run tab with no record behind it", () => {
    // A history not yet fetched, or a bare `.nc` opened directly: "unknown" is
    // not "working", and this is the one case that would otherwise stick.
    const orphan = tabs.openRun({ id: "run-unfetched" });
    const bare = tabs.openRun({ id: null, handle: "abc123" });
    const wrapper = render();
    expect(busyOn(wrapper, orphan)).toBe(false);
    expect(busyOn(wrapper, bare)).toBe(false);
  });

  it("follows the validation phase on the validation tab", async () => {
    const validation = useValidationStore();
    const id = tabs.openValidation();
    const wrapper = render();
    expect(busyOn(wrapper, id)).toBe(false);

    for (const phase of ["syntax", "build"] as const) {
      validation.phase = phase;
      await nextTick();
      expect(busyOn(wrapper, id), phase).toBe(true);
    }
    validation.phase = "done";
    await nextTick();
    expect(busyOn(wrapper, id)).toBe(false);
  });

  it("follows the render phase on the math tab", async () => {
    const math = useMathStore();
    const id = tabs.openMath();
    const wrapper = render();
    expect(busyOn(wrapper, id)).toBe(false);

    math.phase = "rendering";
    await nextTick();
    expect(busyOn(wrapper, id)).toBe(true);

    math.phase = "done";
    await nextTick();
    expect(busyOn(wrapper, id)).toBe(false);
  });

  it("never shows on a file tab, dirty or not", async () => {
    // Dirty is the other per-tab mark, and the two must stay distinct: one is
    // the user's unsaved work, the other is the machine's.
    const id = tabs.openFile("model.yaml");
    const wrapper = render();
    expect(busyOn(wrapper, id)).toBe(false);
    tabs.markDirty(id, "raw");
    await nextTick();
    expect(busyOn(wrapper, id)).toBe(false);
    expect(tabButton(wrapper, id).find('[data-testid="tab-dirty"]').exists()).toBe(true);
  });
});
