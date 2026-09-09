import { describe, expect, it } from "vitest";

import type { VcsChange } from "@/api/vcs";
import { MARK, changedUnder, changesByPath, describeChange } from "./vcsStatus";

const change = (path: string, state: VcsChange["state"], original: string | null = null): VcsChange => ({
  path,
  index: " ",
  worktree: "M",
  state,
  original,
});

describe("vcsStatus", () => {
  it("gives every state a letter and a tone", () => {
    for (const mark of Object.values(MARK)) {
      expect(mark.letter).toHaveLength(1);
      expect(mark.tone).toMatch(/^text-/);
    }
  });

  it("counts a folder's changed files by path prefix, separator included", () => {
    const changes = [
      change("model.yaml", "modified"),
      change("model_config/techs.yaml", "modified"),
      change("model_config/data/demand.csv", "untracked"),
    ];
    expect(changedUnder(changes, "")).toBe(3);
    expect(changedUnder(changes, "model_config")).toBe(2);
    expect(changedUnder(changes, "model_config/data")).toBe(1);
    // `model` is a prefix of `model_config` as text, and not as a folder.
    expect(changedUnder(changes, "model")).toBe(0);
  });

  it("keys changes by path", () => {
    const found = changesByPath([change("a.yaml", "added")]);
    expect(found.get("a.yaml")?.state).toBe("added");
    expect(found.has("b.yaml")).toBe(false);
  });

  it("says where a renamed file came from", () => {
    expect(describeChange(change("new.yaml", "renamed", "old.yaml"))).toBe(
      "Renamed from old.yaml",
    );
    expect(describeChange(change("x.yaml", "deleted"))).toBe("Deleted");
  });
});
