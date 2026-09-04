/**
 * Comparing two versions of one model: `/api/versions/{id}/compare/`.
 *
 * Both sides travel as query parameters rather than path segments, so a
 * scenario name needs no special handling — axios encodes a parameter value —
 * and `path` cannot be mistaken for the route's own shape.
 */
import { formatRef, type CompareRef } from "@/lib/compareRef";

import client from "./client";
import { seg } from "./paths";

/** How the server got the model for one side, and how good that answer is. */
export interface SideModel {
  source: "resolved" | "stale" | "unavailable";
  /** A resolve in flight, to poll for. */
  resolve_task?: string;
  /** Calliope's own complaint, which is usually the real problem. */
  resolve_error?: string;
  /** Why there is nothing to read at all, where that is not Calliope's doing. */
  reason?: string;
}

/** One version of the model, as the server describes it. */
export interface CompareSide {
  ref: string;
  kind: "workspace" | "run";
  label: string;
  scenario: string | null;
  /** False when the scenario named is not one this model defines any more. */
  scenario_known: boolean;
  model: SideModel;

  run_id?: string;
  created_at?: string;
  status?: string;
  override_dict?: Record<string, unknown>;
  /** False when the run's frozen copy was incomplete; null when it has none. */
  snapshot_complete?: boolean | null;
}

export type FileChangeStatus = "added" | "removed" | "modified" | "unchanged";

export interface FileChange {
  path: string;
  type: string;
  status: FileChangeStatus;
  a: { size: number | null; binary: boolean } | null;
  b: { size: number | null; binary: boolean } | null;
}

export interface CompareFiles {
  a: CompareSide;
  b: CompareSide;
  files: FileChange[];
  identical: boolean;
  /** Both sides read the same folder, so only their scenarios differ. */
  same_root: boolean;
}

export interface FilePair {
  path: string;
  binary: boolean;
  a: { content: string; lossy: boolean } | null;
  b: { content: string; lossy: boolean } | null;
}

/** One parameter that differs, at one position. */
export interface DiffChange {
  param: string;
  /** The other dimensions the value is indexed by: node, carrier, cost class. */
  where: Record<string, string>;
  /** A generalised quantity — `power`, `cost` — verbatim from Calliope. */
  unit: string;
  /**
   * The two values, for a parameter that changed.
   *
   * An **added** entity carries `after` alone and a **removed** one `before`:
   * its rows are a listing of what it is, not a change, and a null on the other
   * side would have to be read as "was not there".
   */
  before?: unknown;
  after?: unknown;
  /** Present instead of before/after when the parameter varies over time. */
  series?: {
    /** Absent on an added or removed entity, which changed nothing. */
    changed?: number;
    total: number;
    before_sum?: number | null;
    after_sum?: number | null;
  };
}

export interface DiffEntity {
  kind: "tech" | "link" | "node" | "carrier" | "model";
  name: string;
  status: "added" | "removed" | "changed";
  changes: DiffChange[];
  /** How many further changes were not listed. */
  truncated?: number;
}

export interface DimChange {
  dim: string;
  before: number;
  after: number;
  added?: string[];
  removed?: string[];
  range?: { before: string[] | null; after: string[] | null };
}

export interface ModelDiff {
  entities: DiffEntity[];
  config: Array<{ path: string; before: unknown; after: unknown }>;
  dims: DimChange[];
  summary: Record<string, Record<string, number>>;
  empty: boolean;
}

export interface CompareModel {
  a: CompareSide;
  b: CompareSide;
  available: boolean;
  /** A side is still being read; ask again rather than reporting a failure. */
  pending: boolean;
  reason?: string | null;
  diff?: ModelDiff;
}

const sides = (a: CompareRef, b: CompareRef) => ({
  a: formatRef(a),
  b: formatRef(b),
});

export async function getCompareFiles(
  versionId: string,
  a: CompareRef,
  b: CompareRef,
): Promise<CompareFiles> {
  const res = await client.get(`/api/versions/${seg(versionId)}/compare/`, {
    params: sides(a, b),
  });
  return res.data;
}

export async function getCompareFile(
  versionId: string,
  a: CompareRef,
  b: CompareRef,
  path: string,
): Promise<FilePair> {
  const res = await client.get(`/api/versions/${seg(versionId)}/compare/file/`, {
    params: { ...sides(a, b), path },
  });
  return res.data;
}

export async function getCompareModel(
  versionId: string,
  a: CompareRef,
  b: CompareRef,
): Promise<CompareModel> {
  const res = await client.get(`/api/versions/${seg(versionId)}/compare/model/`, {
    params: sides(a, b),
  });
  return res.data;
}
