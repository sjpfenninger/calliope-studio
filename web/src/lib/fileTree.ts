/**
 * A flat file listing, as a tree.
 *
 * Extracted from `stores/version.ts` so a run's *frozen* file listing can use it
 * too. The two endpoints deliberately return the same shape — that was the point
 * of mirroring `files.py` when the snapshot endpoints were written — so one
 * builder serves both and the tree component needs nothing but a different base
 * URL.
 *
 * Pure, and therefore testable: the directory-collapsing logic is the kind that
 * is quietly wrong for exactly one shape of input.
 */

export interface FileEntry {
  path: string;
  type: "yaml" | "csv" | "other";
  size: number;
}

export interface FileTreeNode {
  key: string;
  label: string;
  type: FileEntry["type"] | "directory";
  leaf: boolean;
  /** Bytes, for a file. Directories do not carry one. */
  size?: number;
  children?: FileTreeNode[];
}

export function buildFileTree(entries: FileEntry[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const directories: Record<string, FileTreeNode> = {};

  function ensureDirectory(parts: string[]): FileTreeNode[] {
    if (parts.length === 0) return root;
    const key = parts.join("/");
    if (!directories[key]) {
      const parent = ensureDirectory(parts.slice(0, -1));
      const node: FileTreeNode = {
        key,
        label: parts[parts.length - 1],
        type: "directory",
        leaf: false,
        children: [],
      };
      parent.push(node);
      directories[key] = node;
    }
    return directories[key].children!;
  }

  for (const entry of entries) {
    const parts = entry.path.split("/");
    ensureDirectory(parts.slice(0, -1)).push({
      key: entry.path,
      label: parts[parts.length - 1],
      type: entry.type,
      leaf: true,
      size: entry.size,
    });
  }

  return root;
}
