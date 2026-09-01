import { describe, expect, it } from "vitest";

import { dirName, resolveDataPath } from "./modelPaths";

describe("dirName", () => {
  it("is empty for a root-level file", () => {
    expect(dirName("model.yaml")).toBe("");
  });

  it("drops the basename", () => {
    expect(dirName("a/b/c.yaml")).toBe("a/b");
  });
});

describe("resolveDataPath", () => {
  it("joins against the declaring file's directory, not the model root", () => {
    // The rule that makes this a helper: model_config/tables.yaml saying
    // `table: costs.csv` means model_config/costs.csv.
    expect(resolveDataPath("model_config/tables.yaml", "costs.csv")).toBe(
      "model_config/costs.csv"
    );
  });

  it("leaves a root-level file's path alone", () => {
    expect(resolveDataPath("model.yaml", "data_tables/costs.csv")).toBe(
      "data_tables/costs.csv"
    );
  });

  it("climbs out of a subdirectory", () => {
    expect(
      resolveDataPath("model_config/techs.yaml", "../data_tables/costs.csv")
    ).toBe("data_tables/costs.csv");
    expect(resolveDataPath("a/b/c.yaml", "../../x.csv")).toBe("x.csv");
  });

  it("normalises . and redundant separators", () => {
    expect(resolveDataPath("model.yaml", "./a/./b.csv")).toBe("a/b.csv");
    expect(resolveDataPath("model.yaml", "a//b.csv")).toBe("a/b.csv");
  });

  it("accepts a Windows-authored separator", () => {
    expect(resolveDataPath("model.yaml", "data_tables\\costs.csv")).toBe(
      "data_tables/costs.csv"
    );
  });

  it("refuses a path that climbs above the workspace", () => {
    expect(resolveDataPath("model.yaml", "../outside.csv")).toBeNull();
    expect(resolveDataPath("a/b/c.yaml", "../../../x.csv")).toBeNull();
  });

  it("refuses an absolute path", () => {
    expect(resolveDataPath("model.yaml", "/etc/passwd")).toBeNull();
    expect(resolveDataPath("model.yaml", "C:\\data.csv")).toBeNull();
    expect(resolveDataPath("model.yaml", "\\\\server\\share.csv")).toBeNull();
  });

  it("refuses anything that is not a single path string", () => {
    // Calliope expects one path, but a list parses, and the editor must not
    // pick one arbitrarily and offer to overwrite it.
    expect(resolveDataPath("model.yaml", ["a.csv", "b.csv"])).toBeNull();
    expect(resolveDataPath("model.yaml", undefined)).toBeNull();
    expect(resolveDataPath("model.yaml", null)).toBeNull();
    expect(resolveDataPath("model.yaml", 5)).toBeNull();
    expect(resolveDataPath("model.yaml", "")).toBeNull();
    expect(resolveDataPath("model.yaml", "   ")).toBeNull();
  });

  it("refuses a path naming a directory", () => {
    expect(resolveDataPath("model.yaml", "data_tables/")).toBeNull();
  });
});
