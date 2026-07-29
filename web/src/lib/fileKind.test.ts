/**
 * The classification that decides which renderer a file gets.
 *
 * The table here is the same one as `tests/test_paths.py::CLASSIFICATIONS`, and
 * has to stay that way — the server answers the same question for the tree's
 * icons, and a disagreement shows as a file whose icon says one thing and whose
 * pane says another.
 */
import { describe, expect, it } from "vitest";

import { fileKindOf, isTextFileType, type FileType } from "./fileKind";

const CLASSIFICATIONS: [string, FileType][] = [
  ["model.yaml", "yaml"],
  ["model.yml", "yaml"],
  ["data_tables/costs.csv", "csv"],
  ["README.md", "markdown"],
  ["notes.markdown", "markdown"],
  ["diagram.png", "image"],
  ["photo.JPEG", "image"],
  ["logo.svg", "image"],
  ["results.nc", "binary"],
  ["archive.zip", "binary"],
  ["sheet.xlsx", "binary"],
  ["LICENSE", "other"],
  ["script.py", "other"],
  ["notes.txt", "other"],
];

describe("fileKindOf", () => {
  it.each(CLASSIFICATIONS)("classifies %s as %s", (path, expected) => {
    expect(fileKindOf(path)).toBe(expected);
  });

  it("matches case-insensitively", () => {
    expect(fileKindOf("A.PNG")).toBe(fileKindOf("a.png"));
  });

  it("reads the extension from the last segment, not the path", () => {
    // A directory carrying a dot used to give every file under it that
    // directory's extension.
    expect(fileKindOf("v0.7/model")).toBe("other");
    expect(fileKindOf("v0.7/model.yaml")).toBe("yaml");
  });

  it("treats a leading dot as a hidden name, not an extension", () => {
    expect(fileKindOf(".gitignore")).toBe("other");
  });
});

describe("isTextFileType", () => {
  it("admits text and refuses what a text editor would destroy", () => {
    // This predicate is what stops Ctrl/Cmd+S writing a replacement-character
    // transcription of a `.png` back over the original bytes.
    expect(isTextFileType("yaml")).toBe(true);
    expect(isTextFileType("markdown")).toBe(true);
    expect(isTextFileType("other")).toBe(true);
    expect(isTextFileType("image")).toBe(false);
    expect(isTextFileType("binary")).toBe(false);
  });
});
