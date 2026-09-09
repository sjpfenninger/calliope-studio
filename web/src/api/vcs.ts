/**
 * Version tracking: `/api/versions/{id}/vcs/…`.
 *
 * The status call is the one poll, and it answers with a *state* rather than
 * a boolean: no git on the machine, a folder in no repository, a folder inside
 * a repository that ignores it, and a folder git will say something about all
 * look identical from an empty list, and two of them are the default dev
 * setup.
 */
import client from "./client";
import { seg } from "./paths";

export type VcsState = "no_git" | "untracked" | "ignored" | "ready";

/** Mirrors `STATES` in src/calliope_studio/vcs/status.py. */
export type VcsFileState =
  | "added"
  | "modified"
  | "deleted"
  | "untracked"
  | "renamed"
  | "conflicted";

export interface VcsStatus {
  /** Whether there is a git binary at all. */
  available: boolean;
  /** Whether git will say anything about this folder's files. */
  tracked: boolean;
  state: VcsState;
  /** The repository's top level, which may be above the model folder. */
  root: string | null;
  branch: string | null;
  detached: boolean;
  /** The model folder is somewhere below the repository's root. */
  nested: boolean;
  /** How many files differ from HEAD. */
  changed: number;
  head: string | null;
  /**
   * What "Track with git" would write as `.gitignore`, verbatim from the
   * server. Null once there is nothing to offer, and when the folder has an
   * ignore file of its own, which is kept.
   */
  gitignore: string | null;
}

export interface VcsChange {
  /** Workspace-relative. */
  path: string;
  index: string;
  worktree: string;
  state: VcsFileState;
  /** Where a renamed file came from. */
  original: string | null;
}

export interface VcsCommit {
  sha: string;
  short: string;
  author: string;
  /** ISO 8601, with the author's offset. */
  date: string;
  subject: string;
  body: string;
}

export interface VcsCommitFile {
  path: string;
  state: VcsFileState;
  original: string | null;
}

export interface VcsCommitDetail {
  commit: VcsCommit;
  /** Null for the first commit. */
  parent: string | null;
  files: VcsCommitFile[];
}

/** Two whole texts, not a patch: the diff pane computes the difference. */
export interface VcsDiff {
  path: string;
  original: string;
  modified: string;
  binary: boolean;
  truncated: boolean;
  original_exists: boolean;
  modified_exists: boolean;
}

const base = (versionId: string) => `/api/versions/${seg(versionId)}/vcs/`;

export async function getVcsStatus(versionId: string): Promise<VcsStatus> {
  const res = await client.get<VcsStatus>(base(versionId));
  return res.data;
}

export interface VcsChanges {
  head: string | null;
  files: VcsChange[];
}

export async function getVcsChanges(versionId: string): Promise<VcsChanges> {
  const res = await client.get<VcsChanges>(`${base(versionId)}changes/`);
  return res.data;
}

export async function getVcsLog(
  versionId: string,
  options: { limit?: number; path?: string } = {},
): Promise<VcsCommit[]> {
  const res = await client.get<{ commits: VcsCommit[] }>(`${base(versionId)}log/`, {
    params: options,
  });
  return res.data.commits;
}

export async function getVcsCommit(
  versionId: string,
  sha: string,
): Promise<VcsCommitDetail> {
  const res = await client.get<VcsCommitDetail>(
    `${base(versionId)}commits/${seg(sha)}/`,
  );
  return res.data;
}

/** No `sha` reads the working tree against HEAD. */
export async function getVcsDiff(
  versionId: string,
  path: string,
  sha?: string | null,
): Promise<VcsDiff> {
  const res = await client.get<VcsDiff>(`${base(versionId)}diff/`, {
    params: sha ? { path, sha } : { path },
  });
  return res.data;
}

export async function initVcs(versionId: string): Promise<VcsStatus> {
  const res = await client.post<VcsStatus>(`${base(versionId)}init/`);
  return res.data;
}

export async function commitVcs(
  versionId: string,
  message: string,
  paths?: string[],
): Promise<{ sha: string; short: string }> {
  const res = await client.post(`${base(versionId)}commit/`, {
    message,
    paths: paths ?? null,
  });
  return res.data;
}

export async function discardVcs(versionId: string, path: string): Promise<void> {
  await client.post(`${base(versionId)}discard/`, { path });
}
