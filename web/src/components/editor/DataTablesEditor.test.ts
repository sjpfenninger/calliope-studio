import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/versions", async () =>
  (await import("@/test-helpers/editorApi")).versionsApi(),
);
vi.mock("@/api/system", async () => (await import("@/test-helpers/editorApi")).systemApi());
// AG Grid measures a viewport; the stub carries the props and the exposed
// method the editor reaches, and draws nothing.
vi.mock("@/components/editor/CsvGrid.vue", async () => ({
  default: (await import("@/test-stubs/CsvGrid")).default,
}));

import * as system from "@/api/system";
import * as versions from "@/api/versions";
import { useTabsStore } from "@/stores/tabs";
import {
  mountEditor,
  resetVersionsApi,
  rowNames,
  section,
  type MountedEditor,
  type SystemApi,
  type VersionsApi,
} from "@/test-helpers/editors";
import CsvGrid from "@/test-stubs/CsvGrid";
import DataTablesEditor from "./DataTablesEditor.vue";

/**
 * A data table is a YAML block *and* a CSV file, and the entry tab saves both.
 *
 * Which of the two a save writes is the invariant `save-check` asserts in a
 * browser and this pins per case: the YAML section only when the form changed
 * — a rewrite of an unchanged section is harmless, but a rewrite of an
 * unchanged CSV goes through `csv.writer` and can change quoting and line
 * endings — and the CSV first, because `table:` is the pointer and a YAML
 * write that lands before a failed CSV write names a file whose edits are gone.
 *
 * `add_dims:` written as a bare placeholder parses to null; stripping every
 * null deleted that line, and its comment, out of a save that touched another
 * field. A key present on load stays.
 */
const api = versions as unknown as VersionsApi;
const schemaApi = system as unknown as SystemApi;

/** `rows` gets a text field; `add_dims` a key/value list; the rest is unknown. */
const SCHEMA = {
  properties: {
    data_tables: {
      patternProperties: {
        "^[^_^\\d][\\w]*$": {
          properties: {
            table: { type: "string" },
            rows: { anyOf: [{ type: "string" }, { type: "array" }, { type: "null" }] },
            columns: { anyOf: [{ type: "string" }, { type: "array" }, { type: "null" }] },
            add_dims: { type: "object" },
          },
        },
      },
    },
  },
};

const TABLES = {
  demand: { table: "../data/demand.csv", rows: "timesteps", add_dims: null },
  costs: { table: "../data/costs.csv", rows: "techs" },
};

const CSV = { columns: [{ name: "a" }, { name: "b" }], rows: [["1", "2"]], revision: "c1" };

/** The Reka splitter measures its panels; here it is two boxes. */
const SPLIT_STUBS = {
  ResizablePanelGroup: { template: "<div><slot /></div>" },
  ResizablePanel: { template: "<div><slot /></div>" },
  ResizableHandle: { template: "<div />" },
};

function open(entryName?: string) {
  return mountEditor(DataTablesEditor, {
    section: "data_tables",
    filePath: "model/data_tables.yaml",
    entryName,
    stubs: SPLIT_STUBS,
  });
}

function nameInput(mounted: MountedEditor, at = 0) {
  return mounted.findAll("dt-entry")[at]!.find('input[type="text"]');
}

/** Edits the first cell through the grid's own write-back channel. */
function editCell(mounted: MountedEditor, value: string) {
  const grid = mounted.host.findComponent(CsvGrid);
  const [column] = grid.props("columnDefs") as Array<{
    valueSetter: (params: { data: Record<string, string>; newValue: unknown }) => boolean;
  }>;
  const [row] = grid.props("rowData") as Record<string, string>[];
  return column!.valueSetter({ data: { ...row! }, newValue: value });
}

enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
  resetVersionsApi(api);
  schemaApi.getCalliopeSchema.mockReset().mockResolvedValue(SCHEMA);
  api.readYamlSection.mockResolvedValue(section(TABLES));
  api.getCsv.mockResolvedValue(CSV);
  api.putCsv.mockResolvedValue("c2");
});

describe("DataTablesEditor", () => {
  it("lists every table on the section tab and fetches no CSV", async () => {
    const mounted = await open();
    expect(rowNames(mounted, "dt-entry")).toEqual(["demand", "costs"]);
    expect(api.getCsv).not.toHaveBeenCalled();
    expect(mounted.find("csv-grid").exists()).toBe(false);
  });

  it("writes nothing for a save that changed nothing", async () => {
    const mounted = await open();
    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(api.putYamlSection).not.toHaveBeenCalled();
    expect(api.putCsv).not.toHaveBeenCalled();
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(false);
  });

  it("opens the CSV that table: names, resolved against the file's own folder", async () => {
    const mounted = await open("demand");
    expect(api.getCsv).toHaveBeenCalledWith("v1", "data/demand.csv");
    expect(mounted.find("csv-grid").exists()).toBe(true);
    expect(mounted.host.text()).toContain("data/demand.csv");
    expect(rowNames(mounted, "dt-entry")).toEqual([""]);
  });

  it("says why there is no grid when table: cannot be opened", async () => {
    api.readYamlSection.mockResolvedValue(
      section({
        many: { table: ["a.csv", "b.csv"] },
        outside: { table: "/etc/passwd" },
        none: {},
      }),
    );
    expect((await open("many")).host.text()).toContain("names more than one file");
    expect((await open("outside")).host.text()).toContain("points outside the model folder");
    expect((await open("none")).host.text()).toContain("has no table: file");
    expect(api.getCsv).not.toHaveBeenCalled();
  });

  it("keeps a key that was null on load, and writes the whole section", async () => {
    const mounted = await open();
    await nameInput(mounted, 1).setValue("costs_renamed");
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(true);

    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(api.putYamlSection).toHaveBeenCalledWith(
      "v1",
      "model/data_tables.yaml",
      "data_tables",
      {
        demand: { table: "../data/demand.csv", rows: "timesteps", add_dims: null },
        costs_renamed: { table: "../data/costs.csv", rows: "techs" },
      },
      "r1",
    );
    expect(api.putCsv).not.toHaveBeenCalled();
    expect(useTabsStore().get(mounted.tabId)?.isDirty).toBe(false);
  });

  it("writes an edited CSV before the YAML, and only the half that changed", async () => {
    const mounted = await open("demand");
    expect(editCell(mounted, "9")).toBe(true);
    await flushPromises();
    const tabs = useTabsStore();
    expect(tabs.get(mounted.tabId)?.isDirty).toBe(true);
    // The CSV file is this tab's while the cells are unsaved, so a file tab on
    // it cannot write the stale text underneath.
    expect(tabs.dirtyOwner("data/demand.csv")).toMatchObject({
      tabId: mounted.tabId,
      source: "held",
    });

    await mounted.find("save").trigger("click");
    await flushPromises();
    expect(api.putCsv).toHaveBeenCalledWith(
      "v1",
      "data/demand.csv",
      CSV.columns,
      [["9", "2"]],
      "c1",
    );
    expect(api.putYamlSection).not.toHaveBeenCalled();
    expect(tabs.get(mounted.tabId)?.isDirty).toBe(false);
    expect(tabs.dirtyOwner("data/demand.csv")).toBeNull();
  });

  it("writes both halves when both changed, CSV first", async () => {
    const mounted = await open("demand");
    editCell(mounted, "9");
    await nameInput(mounted).setValue("demand2");
    await mounted.find("save").trigger("click");
    await flushPromises();

    expect(api.putCsv).toHaveBeenCalledTimes(1);
    expect(api.putYamlSection).toHaveBeenCalledTimes(1);
    expect(api.putCsv.mock.invocationCallOrder[0]).toBeLessThan(
      api.putYamlSection.mock.invocationCallOrder[0]!,
    );
  });

  it("does not follow a table: change while the grid holds unsaved cells", async () => {
    // Reloading on a keystroke would throw cell edits away without asking.
    const mounted = await open("demand");
    editCell(mounted, "9");
    await flushPromises();
    const tableInput = mounted.host
      .findAll("input")
      .find((input) => (input.element as HTMLInputElement).value === "../data/demand.csv")!;
    await tableInput.setValue("../data/other.csv");
    await tableInput.trigger("change");
    await flushPromises();

    expect(api.getCsv).toHaveBeenCalledTimes(1);
    expect(mounted.host.text()).toContain("now points at");
    expect(mounted.host.text()).toContain("data/other.csv");
  });
});
