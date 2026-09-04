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
 *
 * **A directory arrives as an entry in its own right**, and is also still
 * implied by the path of every file under it. It used to be only the latter,
 * which meant an *empty* directory could not be represented — and so could not
 * usefully be created, because it would vanish from the tree the moment the
 * listing was refetched. `ensureDirectory` is idempotent, so the two sources
 * agree by construction.
 */

import type { FileType } from "./fileKind";

export interface FileEntry {
  path: string;
  type: FileType | "directory";
  /** Bytes. Absent for a directory, which has no meaningful size. */
  size?: number;
}

export interface FileTreeNode {
  key: string;
  label: string;
  type: FileEntry["type"];
  leaf: boolean;
  /** Bytes, for a file. Directories do not carry one. */
  size?: number;
  children?: FileTreeNode[];
}

/**
 * Directories first, then by name.
 *
 * Order used to be whatever order the entries arrived in, which put a directory
 * wherever its first file happened to sort. With directories listed explicitly
 * that would become a strictly alphabetical interleaving of folders and files,
 * so the choice had to be made rather than inherited — and folders-first is both
 * the convention and stable regardless of what the server sends.
 *
 * `localeCompare` with `numeric` so `node_10` sorts after `node_9`, which is how
 * real model folders name their files.
 */
function byKind(a: FileTreeNode, b: FileTreeNode): number {
  if (a.leaf !== b.leaf) return a.leaf ? 1 : -1;
  return compareNames(a.label, b.label);
}

/**
 * The one comparator for names a user wrote: `node_10` after `node_9`, and
 * case-insensitive, which is how a folder listing reads and how every other
 * list of identifiers in the app — inherited parameters, filter sections, the
 * model tree — should read too. A bare `.sort()` puts `Z` before `a` and
 * `node_10` before `node_2`.
 */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function sortTree(nodes: FileTreeNode[]): FileTreeNode[] {
  nodes.sort(byKind);
  for (const node of nodes) if (node.children) sortTree(node.children);
  return nodes;
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
    if (entry.type === "directory") {
      ensureDirectory(parts);
      continue;
    }
    ensureDirectory(parts.slice(0, -1)).push({
      key: entry.path,
      label: parts[parts.length - 1],
      type: entry.type,
      leaf: true,
      size: entry.size,
    });
  }

  return sortTree(root);
}

/**
 * Every path in the tree, files and directories alike.
 *
 * For the "is there already something called that?" check when creating. The
 * server refuses a collision too — this is so the answer arrives while the name
 * is being typed rather than after the button is pressed.
 */
export function allPaths(nodes: FileTreeNode[]): Set<string> {
  const found = new Set<string>();
  const walk = (list: FileTreeNode[]) => {
    for (const node of list) {
      found.add(node.key);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return found;
}
