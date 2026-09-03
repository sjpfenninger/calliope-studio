import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { h, nextTick } from "vue";

import TooltipProvider from "@/components/ui/tooltip/TooltipProvider.vue";
import RunListItem from "./RunListItem.vue";
import type { RunRecord } from "@/api/runs";

/**
 * Renaming a run, and the one action that must not be offered mid-solve.
 *
 * A rename is the only place in the run list where a keystroke decides between
 * writing to the server and throwing the edit away, and the two keys are one
 * character apart on the keyboard: Enter commits, Escape abandons and leaves the
 * run named what it was. Getting Escape wrong is silent — the label the user
 * meant to keep is replaced by the draft they were abandoning.
 *
 * Delete is disabled while a run is still going because the files are being
 * written; the guard is a prop on the menu item, which is invisible to every
 * other kind of test here.
 *
 * The menu itself is Reka's and does not open under a headless DOM — no pointer,
 * no floating-ui measurement — so its three shells are stubbed to pass their
 * slots through. What is under test is this component's own bindings, not
 * whether a library's popper positions itself.
 */
const MENU_STUBS = {
  teleport: true,
  DropdownMenuContent: { template: "<div><slot /></div>" },
  DropdownMenuTrigger: { template: "<div><slot /></div>" },
  DropdownMenuItem: {
    props: { disabled: Boolean },
    emits: ["select"],
    template:
      '<button :disabled="disabled" @click="$emit(\'select\')"><slot /></button>',
  },
};

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "abcdef1234567890",
    status: "success",
    created_at: "2026-09-01T10:00:00Z",
    label: "first try",
    workspace: null,
    scenario: null,
    override_dict: {},
    build_only: false,
    started_at: null,
    completed_at: null,
    duration_seconds: 12,
    termination_condition: "optimal",
    solver: "cbc",
    objective: 1234,
    timings: {},
    error: null,
    traceback: null,
    has_results: true,
    has_snapshot: true,
    snapshot_complete: true,
    solved_from: null,
    size_bytes: 4096,
    results_handle: null,
    ...over,
  };
}

function render(record: RunRecord = run()) {
  const wrapper = mount(TooltipProvider, {
    slots: { default: () => h(RunListItem, { run: record, active: false }) },
    global: { stubs: MENU_STUBS },
  });
  return { wrapper, item: wrapper.findComponent(RunListItem) };
}

const byTestId = (wrapper: ReturnType<typeof render>["wrapper"], name: string) =>
  wrapper.find(`[data-testid="${name}"]`);

async function startRename(wrapper: ReturnType<typeof render>["wrapper"]) {
  await byTestId(wrapper, "run-rename-action").trigger("click");
  await nextTick();
  return byTestId(wrapper, "run-rename");
}

describe("RunListItem", () => {
  it("commits a rename on Enter", async () => {
    const { wrapper, item } = render();
    const field = await startRename(wrapper);
    expect((field.element as HTMLInputElement).value).toBe("first try");

    await field.setValue("second try");
    await field.trigger("keydown.enter");

    expect(item.emitted("rename")).toEqual([["second try"]]);
    expect(byTestId(wrapper, "run-rename").exists()).toBe(false);
  });

  it("says nothing when the name is unchanged", async () => {
    // The list writes to the server on this event, so a rename that renames
    // nothing is a request and a history entry for no reason.
    const { wrapper, item } = render();
    const field = await startRename(wrapper);
    await field.trigger("keydown.enter");
    expect(item.emitted("rename")).toBeUndefined();
  });

  it("abandons the draft on Escape and keeps the old label", async () => {
    const { wrapper, item } = render();
    const field = await startRename(wrapper);
    await field.setValue("half-typed");
    await field.trigger("keydown.esc");
    // The field is torn down on Escape, and a real browser fires `blur` on the
    // way — which is the other path into `commitRename`. It has to see that the
    // rename was already abandoned, or Escape writes the draft it discarded.
    await field.trigger("blur");
    await nextTick();

    expect(item.emitted("rename")).toBeUndefined();
    expect(byTestId(wrapper, "run-open").text()).toBe("first try");
  });

  it("will not delete a run that is still going", async () => {
    // The run directory is being written to. The guard is a prop, so nothing
    // else in the suite can see it.
    const { wrapper } = render(run({ status: "running", label: "in flight" }));
    expect(byTestId(wrapper, "run-delete").attributes("disabled")).toBeDefined();
    expect(byTestId(wrapper, "run-cancel-action").exists()).toBe(true);
  });

  it("offers delete and no cancel once a run is finished", async () => {
    const { wrapper, item } = render();
    expect(byTestId(wrapper, "run-delete").attributes("disabled")).toBeUndefined();
    expect(byTestId(wrapper, "run-cancel-action").exists()).toBe(false);

    await byTestId(wrapper, "run-delete").trigger("click");
    expect(item.emitted("remove")).toHaveLength(1);
  });
});
