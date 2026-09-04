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
  chooseOption,
  mountEditor,
  nextFrame,
  pressSave,
  resetVersionsApi,
  rowNames,
  section,
  type VersionsApi,
} from "@/test-helpers/editors";
import TechsEditor from "./TechsEditor.vue";

/**
 * The techs editor as one of two writers of the `techs:` section.
 *
 * It shows the technologies that are not links and saves the whole section,
 * so the property that matters most is what happens to the entries it does
 * *not* show. `lib/techs.test.ts` proves `mergeIntoSection` in isolation; this
 * is the editor wired to it — the ownership snapshot taken at load, extended by
 * a save, and the merge run over what the form actually built. A wrong answer
 * here deletes half a model's technologies from the user's file and marks the
 * tab clean.
 */
const api = versions as unknown as VersionsApi;

const TEMPLATES = {
  power_lines: { base_tech: "transmission", carrier_in: "power" },
  plant: { base_tech: "supply" },
};

/** Two links either side of a plant, so order is observable after a save. */
const SECTION = {
  r1_to_r2: { template: "power_lines", link_from: "r1", link_to: "r2" },
  ccgt: { template: "plant", flow_cap_max: 100 },
  r2_to_r3: { base_tech: "transmission", link_from: "r2", link_to: "r3" },
};

function lastWrite(): Record<string, any> {
  const calls = api.putYamlSection.mock.calls;
  return calls[calls.length - 1]![3];
}

enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
  resetVersionsApi(api);
  api.getTemplates.mockResolvedValue(TEMPLATES);
  api.readYamlSection.mockResolvedValue(section(SECTION));
});

describe("TechsEditor", () => {
  it("shows only the technologies that are not links, template applied", async () => {
    // `r1_to_r2` says nothing about `base_tech` itself; its template does. An
    // editor classifying on the raw entry alone would list it here and let a
    // save strip its endpoints.
    const mounted = await mountEditor(TechsEditor, { section: "techs" });
    expect(rowNames(mounted)).toEqual(["ccgt"]);
    expect(api.getTemplates).toHaveBeenCalledWith("v1");
  });

  it("passes the links through a save untouched and in their original order", async () => {
    const mounted = await mountEditor(TechsEditor, { section: "techs" });
    await chooseOption(mounted, "entry-base-tech", "supply");
    await mounted.find("save").trigger("click");
    await flushPromises();

    const payload = lastWrite();
    expect(Object.keys(payload)).toEqual(["r1_to_r2", "ccgt", "r2_to_r3"]);
    expect(payload.r1_to_r2).toEqual(SECTION.r1_to_r2);
    expect(payload.r2_to_r3).toEqual(SECTION.r2_to_r3);
    expect(payload.ccgt).toEqual({ template: "plant", base_tech: "supply", flow_cap_max: 100 });
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(false);
  });

  it("keeps a renamed technology in its slot and says what it was called", async () => {
    // A rename used to reach the file as a deletion and an addition: the entry
    // moved to the end of the section and its comments went with the deleted
    // key. The save names the rename, and a second one is measured from the
    // name the first save wrote.
    const mounted = await mountEditor(TechsEditor, { section: "techs" });
    await mounted.find("entry-name").setValue("gas");
    await mounted.find("save").trigger("click");
    await flushPromises();
    let [, , , payload, , renames] = api.putYamlSection.mock.calls[0]!;
    expect(Object.keys(payload)).toEqual(["r1_to_r2", "gas", "r2_to_r3"]);
    expect(payload.gas).toEqual(SECTION.ccgt);
    expect(renames).toEqual({ gas: "ccgt" });

    await mounted.find("entry-name").setValue("gas_turbine");
    await mounted.find("save").trigger("click");
    await flushPromises();
    [, , , payload, , renames] = api.putYamlSection.mock.calls[1]!;
    expect(Object.keys(payload)).toEqual(["r1_to_r2", "gas_turbine", "r2_to_r3"]);
    expect(renames).toEqual({ gas_turbine: "gas" });
  });

  it("keeps editing a row whose base_tech was just set to transmission", async () => {
    // Ownership must not be re-derived from what a save wrote. It was: after
    // this save the row on screen answered "not mine", the merge passed the
    // pre-edit original through, and every later edit was discarded with the
    // tab marked clean each time.
    const mounted = await mountEditor(TechsEditor, { section: "techs" });
    await chooseOption(mounted, "entry-base-tech", "transmission");
    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(lastWrite().ccgt).toEqual({
      template: "plant",
      base_tech: "transmission",
      flow_cap_max: 100,
    });

    const template = mounted.host.findAll('input[placeholder="(none)"]')[0]!;
    await template.setValue("power_lines");
    await mounted.find("save").trigger("click");
    await flushPromises();

    expect(api.putYamlSection).toHaveBeenCalledTimes(2);
    expect(lastWrite().ccgt).toEqual({
      template: "power_lines",
      base_tech: "transmission",
      flow_cap_max: 100,
    });
    // Still on screen: reclassification is a reload's job.
    expect(rowNames(mounted)).toEqual(["ccgt"]);
  });

  it("writes an added technology and drops a removed one", async () => {
    const mounted = await mountEditor(TechsEditor, { section: "techs" });
    await mounted.find("add-tech").trigger("click");
    expect(rowNames(mounted)).toEqual(["ccgt", "(unnamed)"]);
    await mounted.findAll("entry-name")[1]!.setValue("battery");
    await mounted.findAll("entry-remove")[0]!.trigger("click");
    // Not gone yet: a technology owns its parameters, so the row asks first.
    expect(rowNames(mounted)).toEqual(["ccgt", "battery"]);
    await answerConfirm(true);
    expect(rowNames(mounted)).toEqual(["battery"]);

    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(lastWrite()).toEqual({
      r1_to_r2: SECTION.r1_to_r2,
      r2_to_r3: SECTION.r2_to_r3,
      battery: {},
    });
  });

  it("keeps a technology whose removal was declined", async () => {
    const mounted = await mountEditor(TechsEditor, { section: "techs" });
    await mounted.find("entry-remove").trigger("click");
    await answerConfirm(false);
    expect(rowNames(mounted)).toEqual(["ccgt"]);
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(false);
  });

  it("puts the cursor in a new technology's name field", async () => {
    // The row arrives called `(unnamed)` with one field that has to be filled
    // in before any other means anything; leaving the cursor on the button
    // sends the next keystroke nowhere.
    const mounted = await mountEditor(TechsEditor, { section: "techs", attach: true });
    await mounted.find("add-tech").trigger("click");
    await nextFrame();
    expect(document.activeElement).toBe(mounted.findAll("entry-name")[1]!.element);
  });

  it("refuses the Save button while there is nothing to save, and says why", async () => {
    const mounted = await mountEditor(TechsEditor, { section: "techs" });
    expect(mounted.find("save").attributes("disabled")).toBeDefined();
    expect(mounted.find("save").element.parentElement?.getAttribute("tabindex")).toBe("0");
    await chooseOption(mounted, "entry-base-tech", "supply");
    expect(mounted.find("save").attributes("disabled")).toBeUndefined();
  });

  it("keeps a dirty form's edit through a flip to Source and back", async () => {
    // The raw buffer is `v-show`n and a dirty pane stays mounted, so the edit
    // survives the round trip — and while Source is in front, Cmd+S belongs
    // to the buffer, not to the form behind it.
    const mounted = await mountEditor(TechsEditor, { section: "techs" });
    const tabs = useTabsStore();
    await chooseOption(mounted, "entry-base-tech", "storage");
    expect(tabs.get(mounted.tabId)?.isDirty).toBe(true);

    await mounted.find("mode-source").trigger("click");
    expect(tabs.get(mounted.tabId)).toMatchObject({ editorMode: "raw" });
    expect(tabs.structuredTabs.map((tab) => tab.id)).toContain(mounted.tabId);
    pressSave();
    await flushPromises();
    expect(api.putYamlSection).not.toHaveBeenCalled();

    await mounted.find("mode-form").trigger("click");
    expect(tabs.get(mounted.tabId)).toMatchObject({ editorMode: "structured" });
    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(lastWrite().ccgt).toMatchObject({ base_tech: "storage" });
  });

  it("does not write a row that has no name", async () => {
    // `edited[""]` would be a key Calliope cannot read; the row stays on screen
    // and is simply not part of the payload.
    const mounted = await mountEditor(TechsEditor, { section: "techs" });
    await mounted.find("add-tech").trigger("click");
    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(Object.keys(lastWrite())).toEqual(["r1_to_r2", "ccgt", "r2_to_r3"]);
  });

  it("marks the tab dirty on an edit and clean once it lands", async () => {
    const mounted = await mountEditor(TechsEditor, { section: "techs" });
    const tabs = useTabsStore();
    expect(tabs.get(mounted.tabId)?.isDirty).toBe(false);
    await chooseOption(mounted, "entry-base-tech", "storage");
    expect(tabs.get(mounted.tabId)?.isDirty).toBe(true);
    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(tabs.get(mounted.tabId)?.isDirty).toBe(false);
  });

  it("asks the data-table endpoint about techs", async () => {
    await mountEditor(TechsEditor, { section: "techs" });
    expect(api.getDataTableParams).toHaveBeenCalledWith("v1", "tech");
  });

  it("shows one technology on an entry tab and offers no add button", async () => {
    const mounted = await mountEditor(TechsEditor, { section: "techs", entryName: "ccgt" });
    expect(rowNames(mounted)).toEqual(["ccgt"]);
    expect(mounted.find("add-tech").exists()).toBe(false);
  });
});
