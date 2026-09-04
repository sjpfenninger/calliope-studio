import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/versions", async () =>
  (await import("@/test-helpers/editorApi")).versionsApi(),
);

import * as versions from "@/api/versions";
import { useTabsStore } from "@/stores/tabs";
import {
  answerConfirm,
  mountEditor,
  pressSave,
  resetVersionsApi,
  rowNames,
  saveByKeyboard,
  section,
  type VersionsApi,
} from "@/test-helpers/editors";
import OverridesEditor from "./OverridesEditor.vue";

/**
 * The one editor with its own transport, and the one that emptied a file.
 *
 * Overrides are served through `/overrides/`, not `yaml-section`: the server
 * applies each flattened path against the structure already in the file, so
 * nested YAML stays nested. An editor that fell back to the section endpoint
 * would read `{}` for every file and write it back flattened.
 *
 * The load-error case is the reported bug. The error used to render as a
 * banner *under* the toolbar, Save button and all, and a save over the empty
 * form it left wrote `{}` — every override in the file, deleted.
 */
const api = versions as unknown as VersionsApi;

const OVERRIDES = {
  cheap_gas: [
    { path: "techs.ccgt.cost_flow_in", value: 0.1 },
    { path: "config.init.name", value: "cheap" },
  ],
  no_storage: [{ path: "techs.battery.active", value: false }],
};

function lastWrite(): Record<string, unknown> {
  const calls = api.putOverrides.mock.calls;
  return calls[calls.length - 1]![2];
}

enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
  resetVersionsApi(api);
  api.readOverrides.mockResolvedValue(section(OVERRIDES));
});

describe("OverridesEditor", () => {
  it("reads and writes through the overrides endpoint and never the section one", async () => {
    const mounted = await mountEditor(OverridesEditor, {
      section: "overrides",
      filePath: "scenarios.yaml",
    });
    expect(api.readOverrides).toHaveBeenCalledWith("v1", "scenarios.yaml");
    expect(api.readYamlSection).not.toHaveBeenCalled();
    expect(rowNames(mounted)).toEqual(["cheap_gas", "no_storage"]);

    await saveByKeyboard(mounted);
    expect(api.putOverrides).toHaveBeenCalledWith("v1", "scenarios.yaml", OVERRIDES, "r1");
    expect(api.putYamlSection).not.toHaveBeenCalled();
  });

  it("renders no Save button when the load failed, so nothing can write {}", async () => {
    api.readOverrides.mockRejectedValue({
      response: { status: 500, data: { detail: "overrides unreadable" } },
    });
    const mounted = await mountEditor(OverridesEditor, { section: "overrides" });
    expect(mounted.host.text()).toContain("overrides unreadable");
    expect(mounted.find("save").exists()).toBe(false);
    expect(mounted.find("add-override").exists()).toBe(false);

    // The keyboard route is the composable's, and it refuses too.
    useTabsStore().activate(mounted.tabId);
    pressSave();
    await flushPromises();
    expect(api.putOverrides).not.toHaveBeenCalled();
  });

  it("drops a setting whose path is blank from the payload", async () => {
    // "Add setting" makes a row with an empty path; left in, the server would
    // be asked to set nothing at all.
    const mounted = await mountEditor(OverridesEditor, { section: "overrides" });
    const addSetting = mounted.host
      .findAll("button")
      .find((button) => button.text() === "Add setting")!;
    await addSetting.trigger("click");
    expect(mounted.findAll("override-setting")).toHaveLength(4);
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(true);

    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(lastWrite()).toEqual(OVERRIDES);
  });

  it("drops a nameless override and keeps the rest", async () => {
    const mounted = await mountEditor(OverridesEditor, { section: "overrides" });
    await mounted.find("add-override").trigger("click");
    expect(rowNames(mounted)).toEqual(["cheap_gas", "no_storage", "(unnamed)"]);
    await mounted.findAll("entry-remove")[1]!.trigger("click");
    await answerConfirm(true);

    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(lastWrite()).toEqual({ cheap_gas: OVERRIDES.cheap_gas });
  });

  it("keeps an override whose removal was declined", async () => {
    const mounted = await mountEditor(OverridesEditor, { section: "overrides" });
    await mounted.findAll("entry-remove")[0]!.trigger("click");
    await answerConfirm(false);
    expect(rowNames(mounted)).toEqual(["cheap_gas", "no_storage"]);
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(false);
  });

  it("writes an edited setting's value in the type it was typed", async () => {
    // The value control is `ScalarOrDataVar`, which reads a number as a number.
    const mounted = await mountEditor(OverridesEditor, { section: "overrides" });
    const value = mounted.findAll("override-setting")[0]!.find("input:not([list])");
    await value.setValue("0.25");
    await mounted.find("save").trigger("click");
    await flushPromises();
    expect((lastWrite().cheap_gas as unknown[])[0]).toEqual({
      path: "techs.ccgt.cost_flow_in",
      value: 0.25,
    });
  });

  it("shows one override on an entry tab", async () => {
    const mounted = await mountEditor(OverridesEditor, {
      section: "overrides",
      entryName: "no_storage",
    });
    expect(rowNames(mounted)).toEqual(["no_storage"]);
    expect(mounted.find("add-override").exists()).toBe(false);
  });
});
