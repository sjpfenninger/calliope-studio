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

    csv.markEdited();
    expect(csv.isDirty.value).toBe(true);

    csv.markSaved();
    expect(csv.isDirty.value).toBe(false);
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
