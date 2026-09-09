/**
 * How a file's git state is shown, and what a folder inherits from its files.
 *
 * Pure, and tested, because two surfaces read it — the file tree's marker
 * and the changes list — and a letter that means one thing in the tree and
 * another in the list is worse than no letter at all.
 */
import type { VcsChange, VcsFileState } from "@/api/vcs";

/** One letter, a tone that says which without the letter being read, and a word. */
export const MARK: Record<VcsFileState, { letter: string; tone: string; label: string }> = {
  modified: { letter: "M", tone: "text-warning-text", label: "Modified" },
  renamed: { letter: "R", tone: "text-warning-text", label: "Renamed" },
  added: { letter: "A", tone: "text-success-text", label: "Added" },
  untracked: { letter: "U", tone: "text-success-text", label: "Untracked" },
  deleted: { letter: "D", tone: "text-danger-text", label: "Deleted" },
  conflicted: { letter: "C", tone: "text-danger-text", label: "Conflicted" },
};

/** The changes keyed by path, for the tree's per-row lookup. */
export function changesByPath(changes: VcsChange[]): Map<string, VcsChange> {
  return new Map(changes.map((change) => [change.path, change]));
}

/**
 * How many changed files sit under a folder.
 *
 * `dir` is workspace-relative with no trailing slash; the root is `""`. The
 * separator is matched, so `model` does not count `model_config/x.yaml`.
 */
export function changedUnder(changes: VcsChange[], dir: string): number {
  if (dir === "") return changes.length;
  const prefix = `${dir}/`;
  return changes.filter((change) => change.path.startsWith(prefix)).length;
}

/** What the change is, in words: "Renamed from techs.yaml". */
export function describeChange(change: VcsChange): string {
  if (change.state === "renamed" && change.original) {
    return `Renamed from ${change.original}`;
  }
  return MARK[change.state].label;
}
