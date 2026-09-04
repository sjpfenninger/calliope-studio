import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/versions", async () =>
  (await import("@/test-helpers/editorApi")).versionsApi(),
);
vi.mock("@/api/system", async () => (await import("@/test-helpers/editorApi")).systemApi());

import * as system from "@/api/system";
import * as versions from "@/api/versions";
import { useTabsStore } from "@/stores/tabs";
import {
  mountEditor,
  resetVersionsApi,
  saveByKeyboard,
  section,
  type VersionsApi,
} from "@/test-helpers/editors";
import ConfigEditor from "./ConfigEditor.vue";

/**
 * What the config editor writes that its form never showed.
 *
 * Two ways a save changed a file the user only looked at. The pre-0.7
 * `time_subset` was written back as itself — a key Calliope no longer accepts
 * — instead of being folded into `subset.timesteps`; and a model declaring only
 * `config.init` gained `build: {}` and `solve: {}` from a no-op save, because
 * the payload always carried all three. Both broke the invariant every
 * structured editor lives by, that a save which changes nothing changes nothing.
 *
 * Loading must not dirty the tab either: the dirty watcher is deep and
 * post-flush, and fires once with the values `apply` just wrote.
 */
const api = versions as unknown as VersionsApi;
const schemaApi = system as unknown as { getCalliopeSchema: ReturnType<typeof vi.fn> };

/** The shape `stores/schema.ts` expects: config alongside, under `x-calliope`. */
const SCHEMA = {
  properties: {},
  "x-calliope": {
    schemas: {
      config: {
        properties: {
          init: {
            properties: {
              name: { type: "string" },
              subset: { type: "object" },
            },
          },
          build: { properties: { mode: { type: "string", enum: ["base", "operate"] } } },
          solve: { properties: { solver: { type: "string" } } },
        },
      },
    },
  },
};

function lastWrite(): Record<string, any> {
  const calls = api.putYamlSection.mock.calls;
  return calls[calls.length - 1]![3];
}

enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
  resetVersionsApi(api);
  schemaApi.getCalliopeSchema.mockReset().mockResolvedValue(SCHEMA);
});

describe("ConfigEditor", () => {
  it("folds a legacy time_subset into subset.timesteps and drops the old key", async () => {
    api.readYamlSection.mockResolvedValue(
      section({ init: { name: "m", time_subset: ["2005-01-01", "2005-01-07"] } }),
    );
    const mounted = await mountEditor(ConfigEditor, { section: "config" });
    await saveByKeyboard(mounted);

    expect(lastWrite()).toEqual({
      init: { name: "m", subset: { timesteps: ["2005-01-01", "2005-01-07"] } },
    });
    expect(lastWrite().init).not.toHaveProperty("time_subset");
  });

  it("leaves a time_subset that cannot be folded where it is", async () => {
    // A scalar cannot become `subset.timesteps`; deleting it anyway would lose
    // the value outright, and an existing `subset.timesteps` must not be
    // overwritten by the legacy spelling.
    api.readYamlSection.mockResolvedValue(
      section({ init: { time_subset: "2005", subset: { timesteps: ["a", "b"] } } }),
    );
    const mounted = await mountEditor(ConfigEditor, { section: "config" });
    await saveByKeyboard(mounted);
    expect(lastWrite()).toEqual({
      init: { time_subset: "2005", subset: { timesteps: ["a", "b"] } },
    });
  });

  it("does not add build: or solve: to a model that declares only init", async () => {
    api.readYamlSection.mockResolvedValue(section({ init: { name: "m" } }));
    const mounted = await mountEditor(ConfigEditor, { section: "config" });
    await saveByKeyboard(mounted);
    expect(lastWrite()).toEqual({ init: { name: "m" } });
  });

  it("keeps a section the file declared even when it is empty", async () => {
    // `build: {}` in the file is a line the user wrote; the save must not
    // remove it just because the form has nothing to put in it.
    api.readYamlSection.mockResolvedValue(section({ init: { name: "m" }, build: {} }));
    const mounted = await mountEditor(ConfigEditor, { section: "config" });
    await saveByKeyboard(mounted);
    expect(lastWrite()).toEqual({ init: { name: "m" }, build: {} });
  });

  it("does not mark the tab dirty by loading", async () => {
    api.readYamlSection.mockResolvedValue(
      section({ init: { name: "m" }, build: { mode: "base" }, solve: { solver: "cbc" } }),
    );
    const mounted = await mountEditor(ConfigEditor, { section: "config" });
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(false);
    expect(mounted.find("save").exists()).toBe(true);
  });

  it("marks the tab dirty on an edit and writes the new value", async () => {
    api.readYamlSection.mockResolvedValue(section({ init: { name: "m" } }));
    const mounted = await mountEditor(ConfigEditor, { section: "config" });
    const name = mounted.host.find('input[type="text"]');
    await name.setValue("renamed");
    await name.trigger("change");
    await flushPromises();
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(true);

    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(lastWrite()).toEqual({ init: { name: "renamed" } });
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(false);
  });

  it("asks which solvers this machine has, for the solve section's suggestions", async () => {
    api.readYamlSection.mockResolvedValue(section({ init: {} }));
    await mountEditor(ConfigEditor, { section: "config" });
    expect(api.getSolvers).toHaveBeenCalledWith("v1");
  });
});
