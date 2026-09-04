import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/versions", async () =>
  (await import("@/test-helpers/editorApi")).versionsApi(),
);
// The real pane imports MapLibre's worker, which cannot be resolved here; the
// editors' relative `./EditorMapPane.vue` resolves to this same id.
vi.mock("@/components/editor/EditorMapPane.vue", async () => ({
  default: (await import("@/test-stubs/EditorMapPane")).default,
}));

import * as versions from "@/api/versions";
import { useTabsStore } from "@/stores/tabs";
import { useUiStore } from "@/stores/ui";
import {
  answerConfirm,
  mountEditor,
  resetVersionsApi,
  rowNames,
  section,
  type MountedEditor,
  type VersionsApi,
} from "@/test-helpers/editors";
import EditorMapPane from "@/test-stubs/EditorMapPane";
import LinksEditor from "./LinksEditor.vue";

/**
 * The links editor: the other writer of `techs:`, and the map's drawing tool.
 *
 * It shares a YAML section with TechsEditor and saves the whole of it, so what
 * it does with the technologies it does not show is the invariant that keeps a
 * user's file intact. The rest is the two-click flow on the map: a link drawn
 * between two nodes gets Calliope's own `{from}_to_{to}` name, a second link
 * between the same pair must not overwrite the first, and Escape has to abandon
 * a half-drawn link — but only for the tab in front, because the listener is on
 * `window` and every dirty pane stays mounted.
 */
const api = versions as unknown as VersionsApi;

const TEMPLATES = { power_lines: { base_tech: "transmission" } };

const SECTION = {
  ccgt: { base_tech: "supply", flow_cap_max: 100 },
  r1_to_r2: { template: "power_lines", link_from: "r1", link_to: "r2" },
  wire: { link_from: "r2", link_to: "r3", flow_cap_max: 5 },
};

function map(mounted: MountedEditor) {
  return mounted.host.findComponent(EditorMapPane);
}

function lastWrite(): Record<string, any> {
  const calls = api.putYamlSection.mock.calls;
  return calls[calls.length - 1]![3];
}

/** Draws a link on the stubbed map: two node clicks. */
async function draw(mounted: MountedEditor, from: string, to: string) {
  map(mounted).vm.$emit("nodeClick", from);
  await flushPromises();
  map(mounted).vm.$emit("nodeClick", to);
  await flushPromises();
}

function escape() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

enableAutoUnmount(afterEach);

beforeEach(() => {
  // The map/list choice is persisted, so one test's list view would open the
  // next test's editor on the list and leave the map stub unmounted.
  localStorage.clear();
  setActivePinia(createPinia());
  resetVersionsApi(api);
  api.getTemplates.mockResolvedValue(TEMPLATES);
  api.readYamlSection.mockResolvedValue(section(SECTION));
});

describe("LinksEditor renames", () => {
  it("keeps a renamed link in its slot and says what it was called", async () => {
    // As for a technology: unnamed, a rename is a deletion and an addition,
    // and the link lands at the end of the section without its comments.
    useUiStore().setSectionView("links", "structured");
    const mounted = await mountEditor(LinksEditor, { section: "techs" });
    await mounted.findAll("link-name")[0]!.setValue("main_line");
    await mounted.find("save").trigger("click");
    await flushPromises();
    const [, , , payload, , renames] = api.putYamlSection.mock.calls[0]!;
    expect(Object.keys(payload)).toEqual(["ccgt", "main_line", "wire"]);
    expect(renames).toEqual({ main_line: "r1_to_r2" });
  });
});

describe("LinksEditor", () => {
  it("lists only the links, whether classified by template or by endpoints", async () => {
    // `wire` has no `base_tech` anywhere; two endpoints are what make a link.
    useUiStore().setSectionView("links", "structured");
    const mounted = await mountEditor(LinksEditor, { section: "techs" });
    expect(rowNames(mounted)).toEqual(["r1_to_r2", "wire"]);
  });

  it("passes the other technologies through a save untouched", async () => {
    useUiStore().setSectionView("links", "structured");
    const mounted = await mountEditor(LinksEditor, { section: "techs" });
    await mounted.findAll("link-to")[1]!.setValue("r4");
    await mounted.find("save").trigger("click");
    await flushPromises();

    const payload = lastWrite();
    expect(Object.keys(payload)).toEqual(["ccgt", "r1_to_r2", "wire"]);
    expect(payload.ccgt).toEqual(SECTION.ccgt);
    // A template that supplies `base_tech` is not doubled up; one that does not
    // gets the explicit key, or the model stops being a link.
    expect(payload.r1_to_r2).toEqual({ template: "power_lines", link_from: "r1", link_to: "r2" });
    expect(payload.wire).toEqual({
      link_from: "r2",
      link_to: "r4",
      base_tech: "transmission",
      flow_cap_max: 5,
    });
  });

  it("names a drawn link {from}_to_{to} and gives a second one a suffix", async () => {
    const mounted = await mountEditor(LinksEditor, { section: "techs" });
    useUiStore().newLinkTemplate = "power_lines";
    await draw(mounted, "r1", "r3");
    // The pair `r1 → r2` already exists in the file: the new one must not
    // replace it.
    await draw(mounted, "r1", "r2");

    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(true);
    // The last link drawn is the one selected, and its form is under the map.
    expect((mounted.find("link-name").element as HTMLInputElement).value).toBe("r1_to_r2_2");

    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(lastWrite().r1_to_r3).toEqual({
      template: "power_lines",
      link_from: "r1",
      link_to: "r3",
    });
    expect(lastWrite().r1_to_r2_2).toEqual({
      template: "power_lines",
      link_from: "r1",
      link_to: "r2",
    });
    expect(lastWrite().r1_to_r2).toEqual(SECTION.r1_to_r2);
  });

  it("cancels a pending link when the same node is clicked again", async () => {
    const mounted = await mountEditor(LinksEditor, { section: "techs" });
    map(mounted).vm.$emit("nodeClick", "r1");
    await flushPromises();
    expect(mounted.find("pending-link").exists()).toBe(true);
    expect(map(mounted).props("pendingLinkFrom")).toBe("r1");

    map(mounted).vm.$emit("nodeClick", "r1");
    await flushPromises();
    expect(mounted.find("pending-link").exists()).toBe(false);
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(false);
  });

  it("abandons a pending link on Escape, but only for the tab in front", async () => {
    // The chip has said "Cancel (Esc)" since the flow was written, and for a
    // while nothing listened — the next node click drew a link nobody asked for.
    const mounted = await mountEditor(LinksEditor, { section: "techs" });
    const tabs = useTabsStore();
    map(mounted).vm.$emit("nodeClick", "r1");
    await flushPromises();

    const other = tabs.openSection("nodes", "model.yaml");
    escape();
    await flushPromises();
    expect(mounted.find("pending-link").exists()).toBe(true);

    tabs.activate(mounted.tabId);
    escape();
    await flushPromises();
    expect(mounted.find("pending-link").exists()).toBe(false);
    expect(tabs.activeId).not.toBe(other);
  });

  it("removes its window listeners when unmounted", async () => {
    // Left behind, a listener keeps a dead pane answering Escape and Cmd+S.
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const mounted = await mountEditor(LinksEditor, { section: "techs" });
    const handlers = added.mock.calls
      .filter(([type]) => type === "keydown")
      .map(([, handler]) => handler);
    expect(handlers.length).toBeGreaterThanOrEqual(2);

    mounted.host.unmount();
    const gone = removed.mock.calls
      .filter(([type]) => type === "keydown")
      .map(([, handler]) => handler);
    for (const handler of handlers) expect(gone).toContain(handler);
    added.mockRestore();
    removed.mockRestore();
  });

  it("drops a removed link from the payload and clears its selection", async () => {
    const mounted = await mountEditor(LinksEditor, { section: "techs" });
    map(mounted).vm.$emit("linkClick", "wire");
    await flushPromises();
    expect((mounted.find("link-name").element as HTMLInputElement).value).toBe("wire");

    await mounted.host.find('[aria-label="Remove this link"]').trigger("click");
    await answerConfirm(true);
    expect(mounted.find("link-name").exists()).toBe(false);

    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(Object.keys(lastWrite())).toEqual(["ccgt", "r1_to_r2"]);
  });

  it("keeps a link whose removal was declined, from the map and from the list", async () => {
    const mounted = await mountEditor(LinksEditor, { section: "techs" });
    map(mounted).vm.$emit("linkClick", "wire");
    await flushPromises();
    await mounted.host.find('[aria-label="Remove this link"]').trigger("click");
    await answerConfirm(false);
    expect((mounted.find("link-name").element as HTMLInputElement).value).toBe("wire");

    useUiStore().setSectionView("links", "structured");
    await flushPromises();
    await mounted.findAll("entry-remove")[0]!.trigger("click");
    await answerConfirm(false);
    expect(rowNames(mounted)).toEqual(["r1_to_r2", "wire"]);
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(false);
  });

  it("switches to the list when a link is added by hand", async () => {
    const mounted = await mountEditor(LinksEditor, { section: "techs" });
    await mounted.find("add-link").trigger("click");
    await flushPromises();
    expect(useUiStore().sectionView.links).toBe("structured");
    expect(rowNames(mounted)).toEqual(["r1_to_r2", "wire", "(unnamed)"]);
  });
});
