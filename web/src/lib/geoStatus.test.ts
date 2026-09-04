import { describe, expect, it } from "vitest";

import { geoStatus } from "./geoStatus";

/**
 * Every row of the server's state table has a sentence, or deliberately none.
 *
 * The one that matters most is stale-with-an-error: it is the state after a
 * save that Calliope refuses, and it used to grey the whole map out with the
 * raw exception text — over a perfectly good last-resolved map.
 */
describe("geoStatus", () => {
  it("says nothing about a resolved model", () => {
    expect(geoStatus("resolved", false, null)).toBeNull();
  });

  it("says nothing while a rebuild after a save is running", () => {
    expect(geoStatus("stale", true, null)).toBeNull();
    expect(geoStatus("stale", true, "old complaint")).toBeNull();
  });

  it("labels the last good reading, and carries Calliope's complaint when there is one", () => {
    expect(geoStatus("stale", false, null)).toMatchObject({ tone: "info" });
    const failed = geoStatus("stale", false, "ModelError: nope");
    expect(failed).toMatchObject({ tone: "warning", detail: "ModelError: nope" });
    expect(failed?.text).toContain("last reading");
  });

  it("labels the YAML-only reading in all three of its states", () => {
    expect(geoStatus("structural", true, null)).toMatchObject({ tone: "info" });
    expect(geoStatus("structural", false, null)).toMatchObject({ tone: "info" });
    expect(geoStatus("structural", false, "ModelError: nope")).toMatchObject({
      tone: "danger",
      detail: "ModelError: nope",
    });
  });

  it("still surfaces a complaint that survived a revert to a resolved state", () => {
    expect(geoStatus("resolved", false, "x")).toMatchObject({ tone: "warning", detail: "x" });
  });
});
