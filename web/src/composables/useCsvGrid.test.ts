import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

import client from "@/api/client";
import { useCsvGrid } from "./useCsvGrid";

vi.mock("@/api/client", () => ({ default: { get: vi.fn() } }));

const api = vi.mocked(client, true);

/**
 * The real header of example-model/data_tables/time_varying_params.csv: one
 * long comment repeated three times and another twice. Keying grid rows by
 * column name collapsed these, and a save then wrote one column's values into
 * all of its namesakes.
 */
const DUPLICATE_HEADER = ["comment", "H", "H", "H", "T", "T"];

function payload(names: string[], rows: string[][]) {
  return {
    data: {
      columns: names.map((name) => ({ name, type: "text" as const })),
      rows,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useCsvGrid", () => {
  it("round-trips a header with duplicate column names", async () => {
    const rows = [
      ["nodes", "region1_1", "region1_2", "region1_3", "region1", "region2"],
      ["techs", "csp", "csp", "csp", "demand_power", "demand_power"],
      ["2005-01-01 00:00", "0", "1", "2", "-10", "-20"],
    ];
    api.get.mockResolvedValue(payload(DUPLICATE_HEADER, rows));

    const csv = useCsvGrid(ref("v1"));
    await csv.load("data_tables/time_varying_params.csv");

    // Six columns in, six columns out — not two.
    expect(csv.columnDefs.value).toHaveLength(6);
    expect(csv.toRows()).toEqual(rows);
  });

  it("keeps the header names for display even when they repeat", async () => {
    api.get.mockResolvedValue(payload(DUPLICATE_HEADER, []));

    const csv = useCsvGrid(ref("v1"));
    await csv.load("t.csv");

    expect(csv.columnDefs.value.map((c: any) => c.headerName)).toEqual(
      DUPLICATE_HEADER
    );
    expect(csv.columnDefs.value.map((c: any) => c.field)).toEqual([
      "c0",
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
    ]);
  });

  it("serialises an untouched load back to exactly what it loaded", async () => {
    const rows = [
      ["ccgt", "750", "", "", "", "0.02", ""],
      ["csp", "1000", "50", "200", "200", "", "0.002"],
    ];
    const names = [
      "parameters",
      "cost_flow_cap",
      "cost_storage_cap",
      "cost_area_use",
      "cost_source_cap",
      "cost_flow_in",
      "cost_flow_out",
    ];
    api.get.mockResolvedValue(payload(names, rows));

    const csv = useCsvGrid(ref("v1"));
    await csv.load("data_tables/costs.csv");

    expect(csv.toRows()).toEqual(rows);
    expect(csv.columns).toHaveLength(names.length);
  });

  it("tracks dirtiness across edit and save", async () => {
    api.get.mockResolvedValue(payload(["a"], [["1"]]));

    const csv = useCsvGrid(ref("v1"));
    await csv.load("t.csv");
    expect(csv.isDirty.value).toBe(false);

    csv.applyEdit({ rowKey: "0", field: "c0", value: "2" });
    expect(csv.isDirty.value).toBe(true);

    csv.markSaved();
    expect(csv.isDirty.value).toBe(false);
  });

  /**
   * ag-grid-vue3 deep-clones `rowData` before handing it to the grid, so the
   * rows AG Grid commits edits into are not the ones `toRows()` serialises.
   * These tests drive the colDef `valueSetter` with a *clone* of the row,
   * exactly as the grid does, and assert the edit still reaches the save
   * payload — an implementation that relies on the grid mutating the loaded
   * rows in place fails every one of them.
   */
  describe("edits committed through the grid's cloned rows", () => {
    async function grid() {
      api.get.mockResolvedValue(
        payload(["name", "value"], [
          ["a", "1"],
          ["b", "2"],
          ["c", "3"],
        ])
      );
      const csv = useCsvGrid(ref("v1"));
      await csv.load("t.csv");
      return csv;
    }

    /** What the wrapper hands AG Grid: a fresh object, same string keys. */
    function cloneOfRow(csv: Awaited<ReturnType<typeof grid>>, i: number) {
      return { ...csv.rowData.value[i] };
    }

    function setterFor(csv: Awaited<ReturnType<typeof grid>>, field: string) {
      const def = csv.columnDefs.value.find((c: any) => c.field === field);
      return def.valueSetter as (params: {
        data: Record<string, string>;
        newValue: unknown;
      }) => boolean;
    }

    it("lands an edit made on a clone in toRows()", async () => {
      const csv = await grid();
      const clone = cloneOfRow(csv, 1);

      const committed = setterFor(csv, "c1")({ data: clone, newValue: "42" });

      expect(committed).toBe(true);
      expect(csv.toRows()[1]).toEqual(["b", "42"]);
      expect(csv.isDirty.value).toBe(true);
      // The clone is the grid's display copy; it must show the value too.
      expect(clone.c1).toBe("42");
    });

    it("identifies the row by its stamp, not its display position", async () => {
      const csv = await grid();
      // A sorted grid shows row 2 first; the clone still carries row 2's stamp.
      const clone = cloneOfRow(csv, 2);

      setterFor(csv, "c1")({ data: clone, newValue: "99" });

      expect(csv.toRows()).toEqual([
        ["a", "1"],
        ["b", "2"],
        ["c", "99"],
      ]);
    });

    it("serialises a cleared cell as an empty string", async () => {
      const csv = await grid();

      setterFor(csv, "c1")({ data: cloneOfRow(csv, 0), newValue: null });

      expect(csv.toRows()[0]).toEqual(["a", ""]);
    });

    it("keeps cells beyond the header width", async () => {
      // A row longer than its header has no column to live in, and a save
      // used to cut it down to the header's width.
      api.get.mockResolvedValue(payload(["a", "b"], [["1", "2", "3"], ["4", "5"]]));
      const csv = useCsvGrid(ref("v1"));
      await csv.load("t.csv");

      setterFor(csv, "c1")({ data: cloneOfRow(csv, 0), newValue: "9" });

      expect(csv.toRows()).toEqual([["1", "9", "3"], ["4", "5"]]);
    });

    it("stringifies a numeric commit", async () => {
      const csv = await grid();

      setterFor(csv, "c1")({ data: cloneOfRow(csv, 0), newValue: 7.5 });

      expect(csv.toRows()[0]).toEqual(["a", "7.5"]);
    });

    it("treats committing an unchanged value as no edit", async () => {
      // Enter on an untouched cell must not dirty the grid: the next save would
      // rewrite (and possibly re-quote) a file whose content did not change.
      const csv = await grid();

      const committed = setterFor(csv, "c1")({
        data: cloneOfRow(csv, 0),
        newValue: "1",
      });

      expect(committed).toBe(false);
      expect(csv.isDirty.value).toBe(false);
    });

    it("keeps the row stamp out of the save payload", async () => {
      const csv = await grid();

      setterFor(csv, "c0")({ data: cloneOfRow(csv, 0), newValue: "z" });

      for (const row of csv.toRows()) expect(row).toHaveLength(2);
    });

    it("refuses an edit it cannot place, and stays clean", async () => {
      const csv = await grid();

      expect(csv.applyEdit({ rowKey: "9", field: "c0", value: "x" })).toBe(false);
      expect(csv.applyEdit({ rowKey: "0", field: "c9", value: "x" })).toBe(false);
      expect(csv.isDirty.value).toBe(false);
      expect(csv.toRows()[0]).toEqual(["a", "1"]);
    });
  });

  it("discards a response for a superseded path", async () => {
    // `data:` changes while a request is in flight; the stale response must not
    // paint over the newer one.
    let releaseFirst: (v: any) => void = () => {};
    api.get
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseFirst = resolve))
      )
      .mockResolvedValueOnce(payload(["b"], [["second"]]));

    const csv = useCsvGrid(ref("v1"));
    const first = csv.load("a.csv");
    await csv.load("b.csv");
    releaseFirst(payload(["a"], [["first"]]));
    await first;

    expect(csv.loadedPath.value).toBe("b.csv");
    expect(csv.toRows()).toEqual([["second"]]);
  });

  it("reports a missing file in words the user can act on", async () => {
    api.get.mockRejectedValue({ response: { status: 404 } });

    const csv = useCsvGrid(ref("v1"));
    await csv.load("gone.csv");

    expect(csv.error.value).toBe("File not found.");
    expect(csv.loadedPath.value).toBeNull();
  });

  it("clears itself when there is no path", async () => {
    api.get.mockResolvedValue(payload(["a"], [["1"]]));

    const csv = useCsvGrid(ref("v1"));
    await csv.load("t.csv");
    await csv.load(null);

    expect(csv.columnDefs.value).toEqual([]);
    expect(csv.rowData.value).toEqual([]);
    expect(csv.isLoading.value).toBe(false);
  });
});
