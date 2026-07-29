/**
 * Turning "this value came from `power_lines`" into somewhere to go.
 *
 * The provenance marker beside a field names the template or data table that
 * supplies the value, and that name is the thing you want to look at next — the
 * whole reason to read the marker is "so where *is* it set?". Answering that by
 * hand meant leaving the editor, guessing which section holds it, and finding the
 * name by eye.
 *
 * The component tree already knows which file defines every named entry and, since
 * `imports.py::_declaring_line`, which line. This is the lookup, kept pure and out
 * of the component so it can be tested: a source that resolves gets a link, and one
 * that does not gets the plain text it had before.
 */
import type { ComponentTree, ComponentTreeEntry } from "@/api/versions";
import type { InheritedSource } from "./inherited";

export interface SourceTarget {
  /** The tree section holding it, which decides how the tab is opened. */
  section: "templates" | "data_tables";
  file: string;
  name: string;
  /** Where in the file, for a section with no structured editor. */
  line?: number;
}

const SECTION: Record<InheritedSource["kind"], SourceTarget["section"]> = {
  template: "templates",
  data_table: "data_tables",
};

/**
 * Where a source is defined, or null if nothing can say.
 *
 * Null is the normal answer in three cases and none of them is an error: the tree
 * has not loaded, the model is mid-edit and the name is not in a file yet, or the
 * server sent a data-table parameter with no table name at all. A marker that
 * cannot be resolved stays exactly as informative as it was.
 */
export function resolveSource(
  tree: ComponentTree | null,
  source: InheritedSource,
): SourceTarget | null {
  const section = SECTION[source.kind];
  const entries = tree?.[section]?.entries ?? [];
  const found = entries.find(
    (entry): entry is ComponentTreeEntry =>
      typeof entry !== "string" && entry.name === source.name,
  );
  if (!found?.file) return null;
  return { section, file: found.file, name: found.name, line: found.line };
}
