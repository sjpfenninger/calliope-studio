/**
 * How a value becomes part of a URL.
 *
 * Forty API URLs were built by interpolating straight into a template literal,
 * and `encodeURIComponent` appeared nowhere in any of them — though
 * `lib/tabId.ts` had already established that every variable segment must be
 * encoded. A model file called `costs (2024).yaml` or `what?.yaml` addressed the
 * wrong resource, silently.
 *
 * **Two encoders, because a file path is not one segment.** The routes that take
 * one declare it `{file_path:path}` — a catch-all — so `nodes/coords.csv` has to
 * arrive with its slash intact. `encodeURIComponent` would send `%2F` and the
 * server would look for a file with a slash in its name. `filePath` therefore
 * encodes each segment and rejoins on `/`: `#`, `?`, `%`, spaces and the rest are
 * escaped, and only the separator survives.
 */

/** One opaque path segment: an id, a handle, a section name. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}

/** A workspace-relative file path, whose `/` separators are structure. */
export function filePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
