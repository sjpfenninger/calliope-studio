import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, ref } from "vue";

vi.mock("@/api/versions", () => ({
  getYamlSection: vi.fn(),
  putYamlSection: vi.fn(),
}));

import { getYamlSection, putYamlSection } from "@/api/versions";
import { useSectionEditor, type SectionEditorOptions } from "./useSectionEditor";

const api = { get: vi.mocked(getYamlSection), put: vi.mocked(putYamlSection) };

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
    let releaseFirst: (data: Record<string, unknown>) => void = () => {};
    api.get
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseFirst = resolve)),
      )
      .mockResolvedValueOnce({ from: "b" });

    const { filePath, applied, wrapper } = harness();
    await flushPromises();

    filePath.value = "b.yaml";
    await flushPromises();
    expect(applied).toEqual([{ from: "b" }]);

    releaseFirst({ from: "a" });
    await flushPromises();
    expect(applied).toEqual([{ from: "b" }]);

    wrapper.unmount();
  });

  it("does not report a save as failed when only the after-hook throws", async () => {
    // The write is on disk by the time `after` runs, so its failure is logged
    // rather than shown as "Failed to save": that message on a save that landed
    // teaches users to distrust the one error surface the editors have.
    api.get.mockResolvedValue({});
    api.put.mockResolvedValue(undefined);
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
    api.get.mockResolvedValue({});
    api.put.mockRejectedValue({ response: { status: 500 } });
    const after = vi.fn();

    const { editor, wrapper } = harness({ after });
    await flushPromises();

    await editor.save();
    expect(editor.saveError.value).toBeTruthy();
    expect(after).not.toHaveBeenCalled();

    wrapper.unmount();
  });
});
