import { describe, expect, it } from "vitest";

import { filePath, seg } from "./paths";

/**
 * The two encoders, and the difference between them.
 *
 * Both failures here are silent. An unencoded `#` truncates the URL at the
 * fragment, so `costs#draft.yaml` addresses `costs` — a *different file that
 * exists* — and the app saves over it without an error anywhere. And a file path
 * sent through `encodeURIComponent` arrives as `nodes%2Fcoords.csv`, which the
 * `{file_path:path}` route reads as one segment containing a slash: a 404 for a
 * file that is plainly there.
 */

describe("seg", () => {
  it("escapes the characters that would otherwise be URL structure", () => {
    expect(seg("a/b")).toBe("a%2Fb");
    expect(seg("costs#draft")).toBe("costs%23draft");
    expect(seg("what?")).toBe("what%3F");
    expect(seg("costs (2024)")).toBe("costs%20(2024)");
    expect(seg("50%")).toBe("50%25");
    // `&` and `=` matter for a value that ends up in a query string.
    expect(seg("a&b=c")).toBe("a%26b%3Dc");
  });

  it("escapes the separator, because an id is one segment", () => {
    // The whole difference from `filePath`: a handle or a section name with a
    // slash in it is a value, not a path, and must not grow a path component.
    expect(seg("nodes/coords.csv")).not.toContain("/");
  });

  it("leaves an ordinary identifier alone", () => {
    // Nearly every call passes one of these, so a wholesale escape would show
    // up in every URL in the log and make a real one hard to spot.
    for (const value of ["techs", "national_scale", "a1b2-c3", "flow_cap"]) {
      expect(seg(value)).toBe(value);
    }
  });

  it("round-trips", () => {
    for (const value of ["a/b", "costs (2024).yaml", "50%", "ünïcode", "a#b?c d"]) {
      expect(decodeURIComponent(seg(value))).toBe(value);
    }
  });
});

describe("filePath", () => {
  it("keeps the separators and escapes everything else", () => {
    expect(filePath("nodes/coords.csv")).toBe("nodes/coords.csv");
    expect(filePath("data tables/costs (2024).csv")).toBe(
      "data%20tables/costs%20(2024).csv",
    );
    expect(filePath("model/what?.yaml")).toBe("model/what%3F.yaml");
    expect(filePath("model/costs#draft.yaml")).toBe("model/costs%23draft.yaml");
    expect(filePath("a/100%/b.csv")).toBe("a/100%25/b.csv");
  });

  it("escapes every segment, not only the last", () => {
    // The obvious half-fix — encode the filename, interpolate the directory —
    // leaves the part of the path most likely to have been typed by a human.
    expect(filePath("my data/sub dir/x.csv")).toBe("my%20data/sub%20dir/x.csv");
  });

  it("preserves a path's own shape, empty segments included", () => {
    // Not normalised: this encodes, and nothing else. A caller that built a
    // doubled slash has a bug of its own, and quietly repairing it here would
    // hide it while making the two encoders disagree about what a path is.
    expect(filePath("a//b.csv")).toBe("a//b.csv");
    expect(filePath("")).toBe("");
    expect(filePath("model.yaml")).toBe("model.yaml");
  });

  it("round-trips, separators and all", () => {
    for (const path of [
      "nodes/coords.csv",
      "data tables/costs (2024).csv",
      "model/what?.yaml",
      "a/100%/b#c.csv",
    ]) {
      expect(decodeURIComponent(filePath(path))).toBe(path);
    }
  });
});
