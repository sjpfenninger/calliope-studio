import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/versions", async () =>
  (await import("@/test-helpers/editorApi")).versionsApi(),
);

import * as versions from "@/api/versions";
import { useComponentTreeStore } from "@/stores/componentTree";
import { useTabsStore } from "@/stores/tabs";
import {
  answerConfirm,
  mountEditor,
  resetVersionsApi,
  saveByKeyboard,
  section,
  type MountedEditor,
  type VersionsApi,
} from "@/test-helpers/editors";
import ScenariosEditor from "./ScenariosEditor.vue";

/**
 * Scenarios are ordered lists of override names, and the order is the meaning.
 *
 * Later overrides win, so the two arrows on each row are not cosmetic — and a
 * move past either end has to be a no-op rather than a splice at -1, which
 * JavaScript happily performs from the other end of the array. Calliope also
 * accepts a bare string where a list belongs; the form has to read it without
 * turning `"o1"` into `["o", "1"]`, and write it back as the list it means.
 */
const api = versions as unknown as VersionsApi;

function lastWrite(): Record<string, unknown> {
  const calls = api.putYamlSection.mock.calls;
  return calls[calls.length - 1]![3];
}

/** The override names listed under each scenario, in order. */
function listed(mounted: MountedEditor): string[][] {
  return mounted
    .findAll("scenario")
    .map((row) => row.findAll("li").map((item) => item.find("span.truncate").text()));
}

function arrow(mounted: MountedEditor, label: string, at: number) {
  return mounted.host.findAll(`[aria-label="${label}"]`)[at]!;
}

enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
  resetVersionsApi(api);
});

describe("ScenariosEditor", () => {
  it("reads a bare string as a one-item list and writes it back as one", async () => {
    api.readYamlSection.mockResolvedValue(section({ solo: "cheap_gas" }));
    const mounted = await mountEditor(ScenariosEditor, { section: "scenarios" });
    expect(listed(mounted)).toEqual([["cheap_gas"]]);

    await saveByKeyboard(mounted);
    expect(lastWrite()).toEqual({ solo: ["cheap_gas"] });
  });

  it("moves an override within its scenario and stops at either end", async () => {
    api.readYamlSection.mockResolvedValue(section({ both: ["a", "b", "c"] }));
    const mounted = await mountEditor(ScenariosEditor, { section: "scenarios" });

    // The ends are disabled, so the pointer cannot ask for the impossible.
    expect(arrow(mounted, "Apply earlier", 0).attributes("disabled")).toBeDefined();
    expect(arrow(mounted, "Apply later", 2).attributes("disabled")).toBeDefined();

    await arrow(mounted, "Apply later", 0).trigger("click");
    expect(listed(mounted)).toEqual([["b", "a", "c"]]);
    await arrow(mounted, "Apply earlier", 2).trigger("click");
    expect(listed(mounted)).toEqual([["b", "c", "a"]]);
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(true);

    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(lastWrite()).toEqual({ both: ["b", "c", "a"] });
  });

  it("flags nothing as unknown until the component tree has loaded", async () => {
    // An empty tree would otherwise mark every override in the model missing.
    api.readYamlSection.mockResolvedValue(section({ s: ["a", "zzz"] }));
    const mounted = await mountEditor(ScenariosEditor, { section: "scenarios" });
    expect(mounted.host.text()).not.toContain("unknown");
  });

  it("flags an override name that no file defines", async () => {
    api.getComponentTree.mockResolvedValue({
      overrides: { entries: [{ name: "a", file: "scenarios.yaml" }] },
    });
    api.readYamlSection.mockResolvedValue(section({ s: ["a", "zzz"] }));
    // The explorer loads the tree; the editor reads whatever it has.
    await useComponentTreeStore().load("v1");
    const mounted = await mountEditor(ScenariosEditor, { section: "scenarios" });
    const rows = mounted.find("scenario").findAll("li");
    expect(rows[0]!.text()).not.toContain("unknown");
    expect(rows[1]!.text()).toContain("unknown");
  });

  it("drops a scenario with no name from the payload", async () => {
    api.readYamlSection.mockResolvedValue(section({ s: ["a"] }));
    const mounted = await mountEditor(ScenariosEditor, { section: "scenarios" });
    await mounted.find("add-scenario").trigger("click");
    expect(mounted.findAll("scenario")).toHaveLength(2);

    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(lastWrite()).toEqual({ s: ["a"] });
  });

  it("removes an override from a scenario without asking", async () => {
    // A bare name inside a scenario owns nothing; only the scenario does.
    api.readYamlSection.mockResolvedValue(section({ s: ["a", "b"] }));
    const mounted = await mountEditor(ScenariosEditor, { section: "scenarios" });
    await arrow(mounted, "Remove a", 0).trigger("click");
    expect(listed(mounted)).toEqual([["b"]]);
    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(lastWrite()).toEqual({ s: ["b"] });
  });

  it("removes a scenario only once the question is answered yes", async () => {
    api.readYamlSection.mockResolvedValue(section({ s: ["a"], t: ["b"] }));
    const mounted = await mountEditor(ScenariosEditor, { section: "scenarios" });
    await mounted.findAll("entry-remove")[0]!.trigger("click");
    await answerConfirm(false);
    expect(mounted.findAll("scenario")).toHaveLength(2);
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(false);

    await mounted.findAll("entry-remove")[0]!.trigger("click");
    await answerConfirm(true);
    expect(mounted.findAll("scenario")).toHaveLength(1);
    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(lastWrite()).toEqual({ t: ["b"] });
  });
});
