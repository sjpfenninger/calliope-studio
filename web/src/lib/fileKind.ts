/**
 * What kind of file a path names, and therefore which renderer it gets.
 *
 * This is answered twice: here, and in `modeldef/paths.py::file_type` for the
 * tree's icons. The duplication is deliberate. A tab restored from a `?tab=`
 * URL is created before the file tree has been fetched, so the client cannot
 * wait for the server's answer — and getting it wrong is not cosmetic here,
 * because it is what decides whether a file reaches Monaco. The two tables are
 * covered by `fileKind.test.ts` and `tests/test_paths.py`, which hold the same
 * list; add an extension to one and add it to both.
 *
 * The list can never be complete, so it is not the safety mechanism. The server
 * sniffs for a NUL byte and refuses to serve a binary as text whatever its name
 * says; this exists so the common cases skip that request entirely and get the
 * right icon.
 */

export type FileType =
  | "yaml"
  | "csv"
  | "markdown"
  | "image"
  | "binary"
  | "other";

/**
 * SVG counts as an image, not as the text it is.
 *
 * Somebody opening one wants to see the drawing. It is served as
 * `image/svg+xml` and drawn through an `<img>`, which cannot run script, so
 * this costs nothing in safety.
 */
const IMAGE_SUFFIXES = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "svg",
]);

const MARKDOWN_SUFFIXES = new Set(["md", "markdown"]);

const BINARY_SUFFIXES = new Set([
  "nc",
  "h5",
  "hdf5",
  "zip",
  "gz",
  "tar",
  "xz",
  "7z",
  "parquet",
  "feather",
  "xlsx",
  "xls",
  "ods",
  "db",
  "sqlite",
  "sqlite3",
  "pdf",
  "pkl",
  "npy",
  "npz",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "so",
  "dylib",
  "dll",
  "exe",
]);

/**
 * The kinds that hold text, and can therefore be edited and saved.
 *
 * An allow-list, for the same reason `EDITABLE_KINDS` in `stores/tabs.ts` is
 * one: the non-editable kinds are the growing half, and a list of what is
 * *excluded* means every new kind has to remember to exclude itself or silently
 * become writable — which here means writable over a file it cannot represent.
 */
export const TEXT_FILE_TYPES: ReadonlySet<FileType> = new Set<FileType>([
  "yaml",
  "csv",
  "markdown",
  "other",
]);

export function isTextFileType(type: FileType): boolean {
  return TEXT_FILE_TYPES.has(type);
}

/** The extension, lowercased, or `""` for a name that has none. */
function suffixOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  // `> 0` rather than `>= 0`: a leading dot is a hidden file, not an extension.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileKindOf(path: string): FileType {
  const suffix = suffixOf(path);
  if (suffix === "yaml" || suffix === "yml") return "yaml";
  if (suffix === "csv") return "csv";
  if (MARKDOWN_SUFFIXES.has(suffix)) return "markdown";
  if (IMAGE_SUFFIXES.has(suffix)) return "image";
  if (BINARY_SUFFIXES.has(suffix)) return "binary";
  return "other";
}
