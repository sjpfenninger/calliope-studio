/**
 * Everything under `/api/versions/{id}/` — the model definition on disk.
 *
 * Modelled on `api/results.ts`, which was the only endpoint module in the tree.
 * The other forty URLs were template literals written wherever they happened to
 * be needed: the `yaml-section` one alone was hand-built thirteen times across
 * eight files, twice per editor, and every one of them interpolated the file
 * path unencoded. Query strings were built two ways, and `/api/health` was the
 * one endpoint written without a trailing slash — a difference nobody could see.
 *
 * These return the payload rather than the axios response, so a caller cannot
 * reach `res.data` and cannot reach `err.response` either — which is what makes
 * `errorDetail` the only way to read a failure and ends the six idioms.
 *
 * The wire types live here too, beside the call that fetches them, rather than
 * in whichever store or component happened to be first to want one. `RunRecord`
 * was declared twice that way and `Health` once typed and once not.
 */
import client from "./client";
import { filePath, seg } from "./paths";
import type { FileEntry } from "../lib/fileTree";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface ComponentTreeEntry {
  name: string;
  file: string;
  /** The 1-based line it is declared on, for a section opened as raw YAML. */
  line?: number;
  template?: string;
  /** Transmission technologies, which the tree presents as links. */
  link_from?: string;
  link_to?: string;
  /** Overrides: how many settings this one makes. */
  setting_count?: number;
  /** Scenarios: which overrides this one composes. */
  overrides?: string[];
}

export interface ComponentTreeSection {
  file?: string;
  entries?: (string | ComponentTreeEntry)[];
}

export interface ComponentTree {
  config?: ComponentTreeSection;
  data_tables?: ComponentTreeSection;
  techs?: ComponentTreeSection;
  nodes?: ComponentTreeSection;
  links?: ComponentTreeSection;
  templates?: ComponentTreeSection;
  overrides?: ComponentTreeSection;
  scenarios?: ComponentTreeSection;
}

// `lib/fileTree` already owned this one, and owns the builder that consumes it.
export type { FileEntry } from "../lib/fileTree";

export interface CsvPayload {
  columns: { name: string }[];
  rows: string[][];
}

export interface WorkspaceSettings {
  run_retention: number | null;
}

/** A YAML section is an arbitrary mapping; only the editors know its shape. */
export type SectionData = Record<string, any>;

// ---------------------------------------------------------------------------
// YAML sections
// ---------------------------------------------------------------------------

export async function getYamlSection(
  versionId: string,
  path: string,
  section: string,
): Promise<SectionData> {
  const res = await client.get<{ section: string; data: SectionData | null }>(
    `/api/versions/${seg(versionId)}/yaml-section/${filePath(path)}`,
    { params: { section } },
  );
  return res.data.data ?? {};
}

export async function putYamlSection(
  versionId: string,
  path: string,
  section: string,
  data: SectionData,
): Promise<void> {
  await client.put(
    `/api/versions/${seg(versionId)}/yaml-section/${filePath(path)}`,
    { data },
    { params: { section } },
  );
}

// ---------------------------------------------------------------------------
// Overrides — not served through yaml-section; an override sets arbitrary paths.
// ---------------------------------------------------------------------------

export interface OverrideSetting {
  path: string;
  value: unknown;
}

export async function getOverrides<T = OverrideSetting>(
  versionId: string,
  path: string,
): Promise<Record<string, T[]>> {
  const res = await client.get<{ overrides: Record<string, T[]> }>(
    `/api/versions/${seg(versionId)}/overrides/${filePath(path)}`,
  );
  return res.data.overrides;
}

export async function putOverrides<T = OverrideSetting>(
  versionId: string,
  path: string,
  overrides: Record<string, T[]>,
): Promise<void> {
  await client.put(`/api/versions/${seg(versionId)}/overrides/${filePath(path)}`, {
    overrides,
  });
}

// ---------------------------------------------------------------------------
// Files and CSVs
// ---------------------------------------------------------------------------

export async function listFiles(versionId: string): Promise<FileEntry[]> {
  const res = await client.get<FileEntry[]>(`/api/versions/${seg(versionId)}/files/`);
  return res.data;
}

export async function getFile(versionId: string, path: string): Promise<string> {
  const res = await client.get<{ content: string }>(
    `/api/versions/${seg(versionId)}/files/${filePath(path)}`,
  );
  return res.data.content;
}

export async function putFile(
  versionId: string,
  path: string,
  content: string,
): Promise<void> {
  await client.put(`/api/versions/${seg(versionId)}/files/${filePath(path)}`, {
    content,
  });
}

/**
 * Where a file's raw bytes live.
 *
 * A URL rather than a request, because the one consumer is an `<img src>`: going
 * through axios into a blob would cost a copy and lose the browser's own cache
 * for no gain. It is still minted here so the route is written once, which is
 * the point of this module.
 */
export function rawFileUrl(versionId: string, path: string): string {
  return `/api/versions/${seg(versionId)}/raw/${filePath(path)}`;
}

/**
 * Creates an empty file. Distinct from `putFile`, which overwrites on purpose.
 *
 * Rejects with 409 if anything is already there, and 400 for a name that would
 * be hidden from the tree once created.
 */
export async function createFile(versionId: string, path: string): Promise<void> {
  await client.post(`/api/versions/${seg(versionId)}/files/${filePath(path)}`);
}

export async function createFolder(versionId: string, path: string): Promise<void> {
  await client.post(`/api/versions/${seg(versionId)}/folders/${filePath(path)}`);
}

export async function getCsv(versionId: string, path: string): Promise<CsvPayload> {
  const res = await client.get<CsvPayload>(
    `/api/versions/${seg(versionId)}/csv/${filePath(path)}`,
  );
  return res.data;
}

/**
 * `rows` is `unknown[][]` rather than `string[][]` on the way *out* even though
 * the server sends strings on the way in: a grid cell holds whatever AG Grid put
 * there, and JSON carries it either way. Narrowing here would only push a cast
 * up into the store.
 */
export async function putCsv(
  versionId: string,
  path: string,
  columns: unknown[],
  rows: unknown[][],
): Promise<void> {
  await client.put(`/api/versions/${seg(versionId)}/csv/${filePath(path)}`, {
    columns,
    rows,
  });
}

// ---------------------------------------------------------------------------
// Resolved views of the definition
// ---------------------------------------------------------------------------

export async function getComponentTree(versionId: string): Promise<ComponentTree> {
  const res = await client.get<ComponentTree>(
    `/api/versions/${seg(versionId)}/component-tree/`,
  );
  return res.data;
}

export async function getTemplates(
  versionId: string,
): Promise<Record<string, Record<string, any>>> {
  const res = await client.get<{ templates: Record<string, any> }>(
    `/api/versions/${seg(versionId)}/templates/`,
  );
  return res.data.templates ?? {};
}

export async function getGeo<T>(versionId: string): Promise<T> {
  const res = await client.get<T>(`/api/versions/${seg(versionId)}/geo/`);
  return res.data;
}

export async function getSchemaKinds<T = string>(
  versionId: string,
): Promise<Record<string, T>> {
  const res = await client.get<{ kinds: Record<string, T> }>(
    `/api/versions/${seg(versionId)}/schema/files/`,
  );
  return res.data.kinds ?? {};
}

export async function getDataTableParams<T>(
  versionId: string,
  kind: "tech" | "node",
): Promise<Record<string, T>> {
  const res = await client.get<{ params: Record<string, T> }>(
    `/api/versions/${seg(versionId)}/data-table-params/`,
    { params: { kind } },
  );
  return res.data.params ?? {};
}

export async function getImportGraph<T>(versionId: string): Promise<T> {
  const res = await client.get<T>(`/api/versions/${seg(versionId)}/import-graph/`);
  return res.data;
}

export async function getScenarioCatalog<T>(versionId: string): Promise<T> {
  const res = await client.get<T>(`/api/versions/${seg(versionId)}/scenarios/`);
  return res.data;
}

// ---------------------------------------------------------------------------
// Settings and validation
// ---------------------------------------------------------------------------

export async function getSettings(versionId: string): Promise<WorkspaceSettings> {
  const res = await client.get<WorkspaceSettings>(
    `/api/versions/${seg(versionId)}/settings/`,
  );
  return res.data;
}

export async function patchSettings(
  versionId: string,
  patch: Partial<WorkspaceSettings>,
): Promise<WorkspaceSettings> {
  const res = await client.patch<WorkspaceSettings>(
    `/api/versions/${seg(versionId)}/settings/`,
    patch,
  );
  return res.data;
}

export async function startValidation<T>(versionId: string): Promise<T> {
  const res = await client.post<T>(`/api/versions/${seg(versionId)}/validate/`);
  return res.data;
}
