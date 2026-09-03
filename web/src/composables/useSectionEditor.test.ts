import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, ref } from "vue";

vi.mock("@/api/versions", () => ({
  readYamlSection: vi.fn(),
  putYamlSection: vi.fn(),
}));

import { putYamlSection, readYamlSection } from "@/api/versions";
import { useTabsStore } from "@/stores/tabs";
import { useSectionEditor, type SectionEditorOptions } from "./useSectionEditor";

const api = { get: vi.mocked(readYamlSection), put: vi.mocked(putYamlSection) };

/** What the section endpoint answers: the data, and the file's revision. */
function read(data: Record<string, unknown>, revision: string | null = null) {
  return { data, revision };
}

/**
 * Mounts the composable inside a throwaway component: it registers lifecycle
 * hooks and a filePath watch, neither of which exists outside a setup scope.
 */
function harness(overrides: Partial<SectionEditorOptions> = {}) {
  const filePath = ref("a.yaml");
  const applied: unknown[] = [];
  let editor!: ReturnType<typeof useSectionEditor>;
  const wrapper: VueWrapper = mount(
    defineComponent({
      setup() {
        editor = useSectionEditor({
          versionId: () => "v1",
          filePath,
          tabId: () => "tab-1",
          section: "techs",
          label: "techs",
          apply: (data) => {
            applied.push(data);
          },
          build: () => ({ built: true }),
          ...overrides,
        });
        return () => null;
      },
    }),
  );
  return { editor, filePath, applied, wrapper };
}

function pressSave() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
});

describe("useSectionEditor", () => {
  it("discards a load superseded by a path change", async () => {
    // The slow read belongs to the first file; the fast one to the second. If
    // the slow response were allowed to apply once it finally arrives, the form
    // would show file A's section while claiming to edit file B's — and the
    // unconditional markClean would bless it.
    let releaseFirst: (data: ReturnType<typeof read>) => void = () => {};
    api.get
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseFirst = resolve)),
      )
      .mockResolvedValueOnce(read({ from: "b" }));

    const { filePath, applied, wrapper } = harness();
    await flushPromises();

    filePath.value = "b.yaml";
    await flushPromises();
    expect(applied).toEqual([{ from: "b" }]);

    releaseFirst(read({ from: "a" }));
    await flushPromises();
    expect(applied).toEqual([{ from: "b" }]);

    wrapper.unmount();
  });

  it("does not report a save as failed when only the after-hook throws", async () => {
    // The write is on disk by the time `after` runs, so its failure is logged
    // rather than shown as "Failed to save": that message on a save that landed
    // teaches users to distrust the one error surface the editors have.
    api.get.mockResolvedValue(read({}));
    api.put.mockResolvedValue(null);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { editor, wrapper } = harness({
      after: () => {
        throw new Error("refresh exploded");
      },
    });
    await flushPromises();

    await editor.save();
    expect(editor.saveError.value).toBeNull();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
    wrapper.unmount();
  });

  it("reports a failed write and never runs the after-hook", async () => {
    api.get.mockResolvedValue(read({}));
    api.put.mockRejectedValue({ response: { status: 500 } });
    const after = vi.fn();

    const { editor, wrapper } = harness({ after });
    await flushPromises();

    await editor.save();
    expect(editor.saveError.value).toBeTruthy();
    expect(after).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("refuses to save a form whose load failed", async () => {
    // `build()` over an empty form is `{}`, and a section write deletes every
    // key absent from its payload: this used to empty the section.
    api.get.mockRejectedValue({ response: { status: 500 } });

    const { editor, wrapper } = harness();
    await flushPromises();
    expect(editor.error.value).toBeTruthy();

    await editor.save();
    expect(api.put).not.toHaveBeenCalled();
    expect(editor.saveError.value).toMatch(/Nothing is loaded/);

    wrapper.unmount();
  });

  it("carries the revision it loaded with into the save", async () => {
    api.get.mockResolvedValue(read({}, "r1"));
    api.put.mockResolvedValue("r2");

    const { editor, wrapper } = harness();
    await flushPromises();
    await editor.save();

    expect(api.put).toHaveBeenCalledWith("v1", "a.yaml", "techs", { built: true }, "r1");
    wrapper.unmount();
  });

  it("answers Cmd+S only for the tab in front", async () => {
    // The listener is on `window` and every dirty pane stays mounted, so one
    // keystroke used to save all of them — two of which could be Techs and
    // Links racing over one file.
    const tabs = useTabsStore();
    const mine = tabs.openSection("techs", "a.yaml");
    tabs.openSection("nodes", "b.yaml");
    api.get.mockResolvedValue(read({}, "r1"));
    api.put.mockResolvedValue("r2");

    const { wrapper } = harness({ tabId: () => mine });
    await flushPromises();

    pressSave();
    await flushPromises();
    expect(api.put).not.toHaveBeenCalled();

    tabs.activate(mine);
    pressSave();
    await flushPromises();
    expect(api.put).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });

  it("keeps the tab dirty when an edit lands while the write is in flight", async () => {
    // `markClean` used to land after the await whatever had been typed
    // meanwhile, and that edit was then never saved by anything.
    const tabs = useTabsStore();
    const id = tabs.openSection("techs", "a.yaml");
    api.get.mockResolvedValue(read({}, "r1"));
    let release: (revision: string) => void = () => {};
    api.put.mockImplementation(() => new Promise((resolve) => (release = resolve)));

    const { editor, wrapper } = harness({ tabId: () => id });
    await flushPromises();

    editor.markDirty();
    const saving = editor.save();
    await flushPromises();
    editor.markDirty();
    release("r2");
    await saving;

    expect(tabs.get(id)?.isDirty).toBe(true);
    wrapper.unmount();
  });

  it("reports a stale baseline as a conflict and keeps the form", async () => {
    const tabs = useTabsStore();
    const id = tabs.openSection("techs", "a.yaml");
    api.get.mockResolvedValue(read({ keep: 1 }, "r1"));
    api.put.mockRejectedValue({
      response: { status: 409, data: { detail: "changed on disk" } },
    });

    const { editor, applied, wrapper } = harness({ tabId: () => id });
    await flushPromises();

    editor.markDirty();
    await editor.save();

    expect(editor.conflict.value).toBe(true);
    expect(editor.saveError.value).toBe("changed on disk");
    // Nothing reloaded on its own: the edits are the user's to keep or drop.
    expect(applied).toHaveLength(1);
    expect(tabs.get(id)?.isDirty).toBe(true);

    wrapper.unmount();
  });

  it("is read-only while another buffer holds the file", async () => {
    const tabs = useTabsStore();
    const other = tabs.openSection("links", "a.yaml");
    tabs.markDirty(other, "form");
    const id = tabs.openSection("techs", "a.yaml");
    api.get.mockResolvedValue(read({}, "r1"));

    const { editor, wrapper } = harness({ tabId: () => id });
    await flushPromises();

    expect(editor.locked.value).toBe(true);
    expect(editor.lockOwner.value?.tabId).toBe(other);
    await editor.save();
    expect(api.put).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("clears only the form's own flag after loading", async () => {
    // The raw buffer of the same tab may hold the user's edits; a load that
    // cleared everything let that tab close without asking.
    const tabs = useTabsStore();
    const id = tabs.openSection("techs", "a.yaml");
    tabs.markDirty(id, "raw");
    api.get.mockResolvedValue(read({}));

    const { wrapper } = harness({ tabId: () => id });
    await flushPromises();

    expect(tabs.get(id)?.isDirty).toBe(true);
    wrapper.unmount();
  });
});
