import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";

/**
 * Which panes exist, and which are merely hidden.
 *
 * `TabBody` is a stack, not a `v-if` chain, and the difference is where three
 * data-loss bugs lived: Monaco disposed every text model — every unsaved edit
 * in every file — when it was `v-if`'d away; a structured editor's form state
 * went with its component when the user looked at another tab; a `.png`
 * opened in the text editor and was written back as replacement characters.
 * Every child here is a labelled stub, because what is under test is the
 * choreography, not the children.
 */
function pane(name: string, props: string[] = []) {
  return defineComponent({
    name: `${name}Stub`,
    props: Object.fromEntries(props.map((prop) => [prop, { default: null }])),
    setup(received) {
      const props = received as unknown as Record<string, unknown>;
      const tab = props.tab as { id?: string } | null | undefined;
      return () =>
        h("div", {
          "data-testid": `pane-${name}`,
          "data-tab": tab?.id,
          "data-path": props.path ?? undefined,
          "data-file-path": props.filePath ?? undefined,
          "data-file-type": props.fileType ?? undefined,
        });
    },
  });
}

vi.mock("@/components/editor/MonacoYamlEditor.vue", () => ({ default: pane("monaco", ["versionId"]) }));
vi.mock("@/components/editor/CsvGridEditor.vue", () => ({ default: pane("csv", ["versionId", "filePath"]) }));
vi.mock("@/components/editor/MarkdownView.vue", () => ({ default: pane("markdown", ["versionId", "path"]) }));
vi.mock("@/components/editor/FileViewer.vue", () => ({ default: pane("viewer", ["versionId", "path", "fileType"]) }));
vi.mock("@/components/compare/CompareTabView.vue", () => ({ default: pane("compare", ["tab"]) }));
vi.mock("@/components/runs/RunTabView.vue", () => ({ default: pane("run", ["tab"]) }));
vi.mock("@/components/validation/ValidationTabView.vue", () => ({ default: pane("validation") }));
vi.mock("@/components/math/MathTabView.vue", () => ({ default: pane("math", ["versionId"]) }));
vi.mock("@/components/shell/StructuredEditorHost.vue", () => ({ default: pane("structured", ["tab", "versionId"]) }));

import { workspaceRef } from "@/lib/compareRef";
import { useTabsStore } from "@/stores/tabs";
import TabBody from "./TabBody.vue";

function render() {
  return mount(TabBody, { global: { stubs: { teleport: true } } });
}

type Wrapper = ReturnType<typeof render>;

const panes = (wrapper: Wrapper, name: string) => wrapper.findAll(`[data-testid="pane-${name}"]`);
// `v-show` is an inline `display: none`, which is what a hidden pane has and
// happy-dom's visibility check does not read.
const visible = (wrapper: Wrapper, name: string) =>
  panes(wrapper, name).filter((el) => (el.element as HTMLElement).style.display !== "none").length;

enableAutoUnmount(afterEach);

describe("TabBody", () => {
  let tabs: ReturnType<typeof useTabsStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    tabs = useTabsStore();
    tabs.setVersion("ws1");
  });

  it("says so when nothing is open, and still mounts Monaco", () => {
    const wrapper = render();
    expect(wrapper.text()).toContain("Open something from the sidebar");
    expect(panes(wrapper, "monaco")).toHaveLength(1);
  });

  it("keeps Monaco mounted and merely hidden across every kind of tab", async () => {
    // The `v-if` that used to be here disposed every text model on the way to
    // a CSV or a run, and with them every unsaved edit in every file tab.
    const wrapper = render();
    tabs.openFile("model.yaml", { fileType: "yaml" });
    await nextTick();
    expect(panes(wrapper, "monaco")).toHaveLength(1);
    expect(visible(wrapper, "monaco")).toBe(1);

    tabs.openFile("data/costs.csv", { fileType: "csv" });
    await nextTick();
    expect(panes(wrapper, "monaco")).toHaveLength(1);
    expect(visible(wrapper, "monaco")).toBe(0);
    expect(visible(wrapper, "csv")).toBe(1);

    tabs.openRun({ id: "r1" });
    await nextTick();
    expect(panes(wrapper, "monaco")).toHaveLength(1);
    expect(visible(wrapper, "monaco")).toBe(0);

    tabs.openCompare(workspaceRef(null), workspaceRef("a"));
    await nextTick();
    expect(panes(wrapper, "monaco")).toHaveLength(1);
    expect(visible(wrapper, "monaco")).toBe(0);

    tabs.activate("file:model.yaml");
    await nextTick();
    expect(visible(wrapper, "monaco")).toBe(1);
  });

  describe("structured editors", () => {
    it("keeps a dirty form mounted after switching away, and drops a clean one", async () => {
      const wrapper = render();
      const techs = tabs.openSection("techs", "model_config/techs.yaml");
      tabs.setEditorMode(techs, "structured");
      await nextTick();
      expect(panes(wrapper, "structured")).toHaveLength(1);

      tabs.markDirty(techs, "form");
      tabs.openFile("model.yaml", { fileType: "yaml" });
      await nextTick();
      // Still there, just hidden: its unsaved state lives in component state.
      expect(panes(wrapper, "structured")).toHaveLength(1);
      expect(visible(wrapper, "structured")).toBe(0);

      tabs.markClean(techs, "form");
      tabs.activate(techs);
      tabs.openFile("model.yaml", { fileType: "yaml" });
      await nextTick();
      expect(panes(wrapper, "structured")).toHaveLength(0);
    });

    it("toggling a form to the raw view hides it without unmounting it", async () => {
      // The form's state is component state; the raw view is Monaco's buffer of
      // the same file. Switching between them must not cost either its edits.
      const wrapper = render();
      const nodes = tabs.openSection("nodes", "model_config/locations.yaml");
      await nextTick();
      expect(visible(wrapper, "structured")).toBe(1);
      expect(visible(wrapper, "monaco")).toBe(0);

      tabs.setEditorMode(nodes, "raw");
      await nextTick();
      expect(panes(wrapper, "structured")).toHaveLength(1);
      expect(visible(wrapper, "structured")).toBe(0);
      expect(visible(wrapper, "monaco")).toBe(1);

      tabs.setEditorMode(nodes, "structured");
      await nextTick();
      expect(visible(wrapper, "structured")).toBe(1);
      expect(visible(wrapper, "monaco")).toBe(0);
    });

    it("shows an entry tab's form the same way", async () => {
      const wrapper = render();
      tabs.openEntry("techs", "model_config/techs.yaml", "ccgt");
      await nextTick();
      expect(panes(wrapper, "structured")).toHaveLength(1);
      expect(panes(wrapper, "structured")[0]!.attributes("data-tab")).toContain("ccgt");
    });
  });

  describe("files that are not text", () => {
    // Tested positively against the text types: `!== "csv"` is what sent a
    // `.png` to the editor, and Ctrl/Cmd+S wrote a string of replacement
    // characters back over it.
    it.each([
      ["diagram.png", "image", "image"],
      ["results.nc", "binary", "binary"],
    ] as const)("opens %s in the viewer, never in Monaco", async (path, fileType, shown) => {
      const wrapper = render();
      tabs.openFile(path, { fileType });
      await nextTick();
      const viewer = panes(wrapper, "viewer");
      expect(viewer).toHaveLength(1);
      expect(viewer[0]!.attributes("data-file-type")).toBe(shown);
      expect(visible(wrapper, "monaco")).toBe(0);
    });

    it("opens a text file of an unknown type in Monaco", async () => {
      const wrapper = render();
      tabs.openFile("notes.txt", { fileType: "other" });
      await nextTick();
      expect(panes(wrapper, "viewer")).toHaveLength(0);
      expect(visible(wrapper, "monaco")).toBe(1);
    });
  });

  it("switches a markdown file between preview and source", async () => {
    const wrapper = render();
    const id = tabs.openFile("README.md", { fileType: "markdown" });
    await nextTick();
    expect(panes(wrapper, "markdown")).toHaveLength(1);
    expect(visible(wrapper, "monaco")).toBe(0);
    expect(wrapper.find('[data-testid="md-source"]').exists()).toBe(true);

    tabs.setFileViewMode(id, "raw");
    await nextTick();
    expect(panes(wrapper, "markdown")).toHaveLength(0);
    expect(visible(wrapper, "monaco")).toBe(1);

    tabs.openFile("model.yaml", { fileType: "yaml" });
    await nextTick();
    expect(wrapper.find('[data-testid="md-source"]').exists()).toBe(false);
  });

  it("destroys a comparison on switch-away but keeps a run pane hidden", async () => {
    const wrapper = render();
    tabs.openRun({ id: "r1" });
    tabs.openCompare(workspaceRef(null), workspaceRef("a"));
    await nextTick();
    expect(panes(wrapper, "compare")).toHaveLength(1);
    expect(panes(wrapper, "run")).toHaveLength(1);
    expect(visible(wrapper, "run")).toBe(0);

    tabs.openFile("model.yaml", { fileType: "yaml" });
    await nextTick();
    expect(panes(wrapper, "compare")).toHaveLength(0);
    expect(panes(wrapper, "run")).toHaveLength(1);
    expect(visible(wrapper, "run")).toBe(0);

    tabs.activate("run:r1");
    await nextTick();
    expect(visible(wrapper, "run")).toBe(1);
  });

  it("keys a CSV grid by path and keeps a dirty grid when another file comes in front", async () => {
    const wrapper = render();
    const csv = tabs.openFile("data/costs.csv", { fileType: "csv" });
    await nextTick();
    expect(panes(wrapper, "csv")[0]!.attributes("data-file-path")).toBe("data/costs.csv");

    tabs.markDirty(csv, "csv");
    tabs.openFile("model.yaml", { fileType: "yaml" });
    await nextTick();
    expect(panes(wrapper, "csv")).toHaveLength(1);
    expect(visible(wrapper, "csv")).toBe(0);

    tabs.markClean(csv, "csv");
    tabs.activate(csv);
    tabs.openFile("model.yaml", { fileType: "yaml" });
    await nextTick();
    expect(panes(wrapper, "csv")).toHaveLength(0);
  });

  it("mounts validation and math panes only while they are in front", async () => {
    const wrapper = render();
    tabs.openValidation();
    await nextTick();
    expect(panes(wrapper, "validation")).toHaveLength(1);
    tabs.openMath();
    await nextTick();
    expect(panes(wrapper, "validation")).toHaveLength(0);
    expect(panes(wrapper, "math")).toHaveLength(1);
  });
});
