/**
 * Tab identity.
 *
 * One string per open tab, used three ways: as the key of the tab map, as the
 * DOM key of the tab bar, and as the `?tab=` query value that makes a tab
 * deep-linkable. Every variable segment is therefore percent-encoded — file
 * paths contain `/`, and an entry name can contain anything at all.
 *
 * This replaces a scheme that prefixed virtual tabs with a `\0` sentinel and
 * joined the rest with colons. That had three problems, and adding a fourth kind
 * of tab made each worse: parsing had to *guess* where the file path ended by
 * taking the last colon, which is wrong for any entry name containing one; the
 * keys were not URL-safe, so a tab could not be named in a query param; and the
 * "file" kind was defined by the *absence* of a sentinel, so every new kind had
 * to remember to add one or be silently misread as a path.
 *
 *     file:{path}
 *     section:{section}:{filePath}
 *     entry:{section}:{filePath}:{entryName}
 *     run:{runId}          a run started in this workspace
 *     run:~{handle}        a bare results file, which has no run
 *     validation           this model's validation results
 *
 * `validation` carries no segment. A window holds one model version, and its
 * results are about that model as a whole rather than about anything in it, so
 * there is nothing to name — which makes it the one id with an empty tail.
 */

export type TabSpec =
  | { kind: "file"; path: string }
  | { kind: "section"; section: string; filePath: string }
  | { kind: "entry"; section: string; filePath: string; entryName: string }
  | { kind: "run"; runId: string | null; handle: string | null }
  | { kind: "validation" };

export type TabKind = TabSpec["kind"];

const encode = encodeURIComponent;
const decode = decodeURIComponent;

export function tabId(spec: TabSpec): string {
  switch (spec.kind) {
    case "file":
      return `file:${encode(spec.path)}`;
    case "section":
      return `section:${encode(spec.section)}:${encode(spec.filePath)}`;
    case "entry":
      return `entry:${encode(spec.section)}:${encode(spec.filePath)}:${encode(
        spec.entryName,
      )}`;
    case "run":
      // A results file opened directly has no run, so its handle identifies it.
      // The `~` keeps the two apart without a fifth kind.
      return spec.runId
        ? `run:${encode(spec.runId)}`
        : `run:~${encode(spec.handle ?? "")}`;
    case "validation":
      return "validation";
  }
}

/**
 * Parses an id back into its parts.
 *
 * Returns null for anything unrecognised rather than throwing: these ids travel
 * in URLs, and a URL outlives the scheme that wrote it. A stale bookmark should
 * open the app, not break it.
 */
export function parseTabId(id: string): TabSpec | null {
  const [prefix, ...rest] = id.split(":");

  switch (prefix) {
    case "file":
      return rest.length === 1 ? { kind: "file", path: decode(rest[0]) } : null;

    case "section":
      return rest.length === 2
        ? { kind: "section", section: decode(rest[0]), filePath: decode(rest[1]) }
        : null;

    case "entry":
      return rest.length === 3
        ? {
            kind: "entry",
            section: decode(rest[0]),
            filePath: decode(rest[1]),
            entryName: decode(rest[2]),
          }
        : null;

    case "run": {
      if (rest.length !== 1) return null;
      const reference = rest[0];
      return reference.startsWith("~")
        ? { kind: "run", runId: null, handle: decode(reference.slice(1)) }
        : { kind: "run", runId: decode(reference), handle: null };
    }

    // The one kind with no segments: `"validation".split(":")` leaves `rest`
    // empty, so the length check that guards every other kind reads `0` here.
    case "validation":
      return rest.length === 0 ? { kind: "validation" } : null;

    default:
      return null;
  }
}

// Convenience constructors, so callers never hand-build a spec object.

export const fileTabId = (path: string): string => tabId({ kind: "file", path });

export const sectionTabId = (section: string, filePath: string): string =>
  tabId({ kind: "section", section, filePath });

export const entryTabId = (
  section: string,
  filePath: string,
  entryName: string,
): string => tabId({ kind: "entry", section, filePath, entryName });

export const runTabId = (runId: string | null, handle: string | null = null): string =>
  tabId({ kind: "run", runId, handle });

export const validationTabId = (): string => tabId({ kind: "validation" });
