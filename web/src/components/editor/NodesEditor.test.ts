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
import { EMPTY_GEO } from "@/test-helpers/editorApi";
import EditorMapPane from "@/test-stubs/EditorMapPane";
import NodesEditor from "./NodesEditor.vue";

/**
 * The nodes editor as the map's other half.
 *
 * On the map a node is an input: dragging it writes coordinates, clicking it
 * opens its form. What the editor does with those events is where a wrong
 * number lands in a user's file — a drag that wrote the projection's full float,
 * a drag that never marked the tab dirty and so could be closed without asking,
 * a selection looked up by name that vanished on the first keystroke of a
 * rename. The map itself is a stub; these are the editor's own rules.
 */
const api = versions as unknown as VersionsApi;

const TWO_NODES = {
  r1: { latitude: 51.5, longitude: -0.1 },
  r2: { latitude: 48.9, longitude: 2.3, template: "city" },
};

function map(mounted: MountedEditor) {
  return mounted.host.findComponent(EditorMapPane);
}

/** What was written by the one save, as the section endpoint received it. */
function written(): Record<string, any> {
  expect(api.putYamlSection).toHaveBeenCalledTimes(1);
  return api.putYamlSection.mock.calls[0]![3];
}

enableAutoUnmount(afterEach);

beforeEach(() => {
  // The map/list choice is persisted, so one test's list view would open the
  // next test's editor on the list and leave the map stub unmounted.
  localStorage.clear();
  setActivePinia(createPinia());
  resetVersionsApi(api);
  api.readYamlSection.mockResolvedValue(section(TWO_NODES));
});

describe("NodesEditor renames", () => {
  it("says what a renamed node was called, so the server keeps its slot", async () => {
    // The nodes form writes its rows in order, so the client never moved a
    // renamed node — the server did, seeing an unknown key and appending it.
    useUiStore().setSectionView("nodes", "structured");
    const mounted = await mountEditor(NodesEditor, { section: "nodes" });
    await mounted.findAll("node-name")[0]!.setValue("north");
    await mounted.find("save").trigger("click");
    await flushPromises();
    const [, , , payload, , renames] = api.putYamlSection.mock.calls[0]!;
    expect(Object.keys(payload)).toEqual(["north", "r2"]);
    expect(renames).toEqual({ north: "r1" });
  });
});

describe("NodesEditor", () => {
  it("tells the map which reading it shows, and what Calliope said", async () => {
    // The server keeps serving the last good resolution after a save Calliope
    // refuses; the pane labels it rather than greying it out.
    api.getGeo.mockResolvedValue({ ...EMPTY_GEO, source: "stale", resolve_error: "nope" });
    const mounted = await mountEditor(NodesEditor, { section: "nodes" });
    expect(map(mounted).props("source")).toBe("stale");
    expect(map(mounted).props("error")).toBe("nope");
    expect(map(mounted).props("resolving")).toBe(false);
  });

  it("follows a resolve in flight until it lands", async () => {
    api.getGeo.mockResolvedValue({ ...EMPTY_GEO, source: "structural", resolve_task: "t1" });
    const mounted = await mountEditor(NodesEditor, { section: "nodes" });
    expect(map(mounted).props("resolving")).toBe(true);
    expect(map(mounted).props("source")).toBe("structural");

    api.getGeo.mockResolvedValue({ ...EMPTY_GEO, source: "resolved" });
    // The poll is on a real timer; waited for rather than slept through.
    await vi.waitFor(() => expect(map(mounted).props("resolving")).toBe(false), {
      timeout: 5000,
    });
    expect(map(mounted).props("source")).toBe("resolved");
  });

  it("opens on the map, and lists the section's nodes when asked", async () => {
    const mounted = await mountEditor(NodesEditor, { section: "nodes" });
    expect(mounted.find("editor-map").exists()).toBe(true);
    expect(mounted.findAll("entry-row")).toHaveLength(0);

    await mounted.find("view-list").trigger("click");
    expect(mounted.find("editor-map").exists()).toBe(false);
    expect(rowNames(mounted)).toEqual(["r1", "r2"]);
  });

  it("disables the map view, with a reason, while no node has coordinates", async () => {
    // A map of none of the nodes is a scrim over nothing; the fix is in the
    // list, so the segment says so rather than leading there.
    api.readYamlSection.mockResolvedValue(section({ r1: {}, r2: { template: "city" } }));
    useUiStore().setSectionView("nodes", "structured");
    const mounted = await mountEditor(NodesEditor, { section: "nodes" });
    expect(mounted.find("view-map").attributes("disabled")).toBeDefined();
    expect(mounted.find("view-list").attributes("disabled")).toBeUndefined();
  });

  it("writes a dragged node's position rounded to five decimals, as numbers", async () => {
    // A drag yields whatever float the projection happens to produce; fifteen
    // digits of it in a file people hand-edit is noise, and a string where a
    // number belongs is a model Calliope refuses to read.
    const mounted = await mountEditor(NodesEditor, { section: "nodes" });
    map(mounted).vm.$emit("nodeMoved", {
      node: "r1",
      latitude: 51.123456789,
      longitude: -0.987654321,
    });
    await flushPromises();

    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(true);
    // The form under the map follows the drag, so the number can be checked.
    expect((mounted.find("node-latitude").element as HTMLInputElement).value).toBe(
      "51.12346",
    );

    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(written().r1).toEqual({ latitude: 51.12346, longitude: -0.98765 });
  });

  it("ignores a drag of a node this file does not define", async () => {
    // The map also draws nodes from other files; they are not editable, and a
    // move event for one must not create an entry or dirty the tab.
    const mounted = await mountEditor(NodesEditor, { section: "nodes" });
    map(mounted).vm.$emit("nodeMoved", { node: "elsewhere", latitude: 1, longitude: 2 });
    await flushPromises();
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(false);
    // Nothing to save, so the button says so; a real edit proves no entry
    // was created for the foreign node.
    expect(mounted.find("save").attributes("disabled")).toBeDefined();
    useUiStore().setSectionView("nodes", "structured");
    await flushPromises();
    await mounted.findAll("node-latitude")[0]!.setValue("52");
    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(Object.keys(written())).toEqual(["r1", "r2"]);
  });

  it("switches to the list when a node is added", async () => {
    // A node with no name and no coordinates cannot be shown on a map, so
    // adding one from the map view would put the new row nowhere visible.
    const mounted = await mountEditor(NodesEditor, { section: "nodes" });
    await mounted.find("add-node").trigger("click");
    await flushPromises();

    expect(useUiStore().sectionView.nodes).toBe("structured");
    expect(mounted.find("editor-map").exists()).toBe(false);
    expect(rowNames(mounted)).toEqual(["r1", "r2", "(unnamed)"]);
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(true);
  });

  it("keeps the selection through a rename and drops it when that row is removed", async () => {
    // The selection is the entry, not its name: a lookup by name matched
    // nothing on the first keystroke of a rename and the form vanished
    // mid-word. Removal is then by the same identity — the name on screen is
    // no longer the one the selection was made with.
    const mounted = await mountEditor(NodesEditor, { section: "nodes" });
    map(mounted).vm.$emit("update:selected", ["r1"]);
    await flushPromises();

    const name = mounted.find("editor-map-detail").find('[data-testid="node-name"]');
    expect((name.element as HTMLInputElement).value).toBe("r1");
    await name.setValue("r1_renamed");
    expect(mounted.find("editor-map-detail").find('[data-testid="node-name"]').exists()).toBe(
      true,
    );
    expect(map(mounted).props("selected")).toEqual(["r1_renamed"]);

    useUiStore().setSectionView("nodes", "structured");
    await flushPromises();
    expect(rowNames(mounted)).toEqual(["r1_renamed", "r2"]);
    await mounted.findAll("entry-remove")[0]!.trigger("click");
    await answerConfirm(true);
    expect(rowNames(mounted)).toEqual(["r2"]);

    useUiStore().setSectionView("nodes", "map");
    await flushPromises();
    expect(map(mounted).props("selected")).toEqual([]);
    expect(mounted.find("editor-map-detail").find('[data-testid="node-name"]').exists()).toBe(
      false,
    );
    expect(mounted.find("editor-map-detail").text()).toContain("Click a node to edit it");
  });

  it("keeps a node whose removal was declined", async () => {
    useUiStore().setSectionView("nodes", "structured");
    const mounted = await mountEditor(NodesEditor, { section: "nodes" });
    await mounted.findAll("entry-remove")[0]!.trigger("click");
    await answerConfirm(false);
    expect(rowNames(mounted)).toEqual(["r1", "r2"]);
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(false);
  });

  it("writes the whole section back, not only the row that changed", async () => {
    // A section write deletes every key absent from its payload.
    useUiStore().setSectionView("nodes", "structured");
    const mounted = await mountEditor(NodesEditor, { section: "nodes" });
    await mounted.findAll("node-latitude")[0]!.setValue("52");
    await mounted.find("save").trigger("click");
    await flushPromises();

    expect(written()).toEqual({
      r1: { latitude: 52, longitude: -0.1 },
      r2: { latitude: 48.9, longitude: 2.3, template: "city" },
    });
    expect(api.putYamlSection).toHaveBeenCalledWith(
      "v1",
      "model.yaml",
      "nodes",
      expect.anything(),
      "r1",
      {},
    );
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(false);
  });

  it("asks the data-table endpoint about nodes, not techs", async () => {
    await mountEditor(NodesEditor, { section: "nodes" });
    expect(api.getDataTableParams).toHaveBeenCalledWith("v1", "node");
  });
});
