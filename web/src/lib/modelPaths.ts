/**
 * Resolving paths that a model definition names, the way the server does.
 *
 * A data table's `table:` is relative to **the YAML file that declares it**, not
 * to the model root — `modeldef/data_tables.py` captures `directory =
 * yaml_path.parent` and joins against that, and `snapshot.py` does the same when
 * it freezes a run. A helper rather than an inline join because the containment
 * rule matters: a `table:` that escapes the workspace is something the server
 * refuses, so the editor must not offer to open it either.
 *
 * The check here is textual, where Python's is `Path.resolve()` +
 * `is_relative_to(root)`. The browser cannot follow symlinks, and does not need
 * to: this only decides which path to show a grid for, and
 * `server/deps.py::resolve_path` re-checks every request.
 */

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/** The directory part of a workspace-relative path; "" for a root-level file. */
export function dirName(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

function isAbsolute(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || WINDOWS_DRIVE.test(value);
}

/**
 * Resolves a data table's `table:` value against its declaring YAML file.
 *
 * Returns a workspace-relative POSIX path, or null when there is nothing
 * openable: `table:` absent, empty, or not a string (Calliope expects a single
 * path, but a list parses); absolute; naming a directory; or climbing out of the
 * workspace root.
 */
export function resolveDataPath(
  yamlFilePath: string,
  dataField: unknown
): string | null {
  if (typeof dataField !== "string") return null;

  const raw = dataField.trim();
  if (!raw || isAbsolute(raw)) return null;

  // Backslashes are a path separator to Windows and a literal to POSIX. A model
  // written on Windows is still a model, so normalise rather than reject.
  const joined = [dirName(yamlFilePath), raw.replace(/\\/g, "/")]
    .filter(Boolean)
    .join("/");
  if (joined.endsWith("/")) return null;

  const out: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // Nothing left to pop means the path has climbed above the workspace.
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }

  return out.length ? out.join("/") : null;
}
