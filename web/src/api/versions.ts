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
  /** Math sources: see `MathSource`, whose shape this group's entries share. */
  kind?: "builtin" | "user" | "unknown";
  applied?: boolean;
  path?: string;
  missing?: boolean;
  shadows_builtin?: boolean;
  counts?: Record<string, number>;
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
  math?: ComponentTreeSection;
}

// `lib/fileTree` already owned this one, and owns the builder that consumes it.
export type { FileEntry } from "../lib/fileTree";

export interface CsvPayload {
  columns: { name: string; type?: "numeric" | "text" }[];
  rows: string[][];
  /** See `Revised`. */
  revision?: string | null;
}

/**
 * Something the client may write back, and what it was based on.
 *
 * Every read a save can follow carries the file's revision, and the save
 * carries it back: the server refuses (409) a write whose baseline is no
 * longer what is on disk — a second browser tab, an editor outside the app —
 * rather than letting the older state silently erase the newer. Null from a
 * server that predates it, which is then simply not checked.
 */
export interface Revised<T> {
  data: T;
  revision: string | null;
}

export interface WorkspaceSettings {
  run_retention: number | null;
}

/** A YAML section is an arbitrary mapping; only the editors know its shape. */
export type SectionData = Record<string, any>;

// ---------------------------------------------------------------------------
// YAML sections
// ---------------------------------------------------------------------------

export async function readYamlSection(
  versionId: string,
  path: string,
  section: string,
): Promise<Revised<SectionData>> {
  const res = await client.get<{
    section: string;
    data: SectionData | null;
    revision?: string | null;
  }>(`/api/versions/${seg(versionId)}/yaml-section/${filePath(path)}`, {
    params: { section },
  });
  return { data: res.data.data ?? {}, revision: res.data.revision ?? null };
}

/** `readYamlSection` for a caller that only looks and never writes back. */
export async function getYamlSection(
  versionId: string,
  path: string,
  section: string,
): Promise<SectionData> {
  return (await readYamlSection(versionId, path, section)).data;
}

/** Returns the file's revision after the write, for the next save to carry. */
export async function putYamlSection(
  versionId: string,
  path: string,
  section: string,
  data: SectionData,
  revision: string | null = null,
): Promise<string | null> {
  const res = await client.put<{ ok: boolean; revision?: string | null }>(
    `/api/versions/${seg(versionId)}/yaml-section/${filePath(path)}`,
    { data, revision },
    { params: { section } },
  );
  return res?.data?.revision ?? null;
}

// ---------------------------------------------------------------------------
// Overrides — not served through yaml-section; an override sets arbitrary paths.
// ---------------------------------------------------------------------------

export interface OverrideSetting {
  path: string;
  value: unknown;
}

export async function readOverrides<T = OverrideSetting>(
  versionId: string,
  path: string,
): Promise<Revised<Record<string, T[]>>> {
  const res = await client.get<{
    overrides: Record<string, T[]>;
    revision?: string | null;
  }>(`/api/versions/${seg(versionId)}/overrides/${filePath(path)}`);
  return { data: res.data.overrides, revision: res.data.revision ?? null };
}

export async function getOverrides<T = OverrideSetting>(
  versionId: string,
  path: string,
): Promise<Record<string, T[]>> {
  return (await readOverrides<T>(versionId, path)).data;
}

export async function putOverrides<T = OverrideSetting>(
  versionId: string,
  path: string,
  overrides: Record<string, T[]>,
  revision: string | null = null,
): Promise<string | null> {
  const res = await client.put<{ ok: boolean; revision?: string | null }>(
    `/api/versions/${seg(versionId)}/overrides/${filePath(path)}`,
    { overrides, revision },
  );
  return res?.data?.revision ?? null;
}

// ---------------------------------------------------------------------------
// Files and CSVs
// ---------------------------------------------------------------------------

export async function listFiles(versionId: string): Promise<FileEntry[]> {
  const res = await client.get<FileEntry[]>(`/api/versions/${seg(versionId)}/files/`);
  return res.data;
}

export interface FileRead {
  content: string;
  /**
   * The bytes were not all UTF-8 and some became U+FFFD on the way in. Such a
   * buffer must not be saved: the replacement character would be written over
   * the original byte, silently, in a file the user opened only to look at.
   */
  lossy: boolean;
  revision: string | null;
}

export async function readFile(versionId: string, path: string): Promise<FileRead> {
  const res = await client.get<{
    content: string;
    lossy?: boolean;
    revision?: string | null;
  }>(`/api/versions/${seg(versionId)}/files/${filePath(path)}`);
  return {
    content: res.data.content,
    lossy: res.data.lossy ?? false,
    revision: res.data.revision ?? null,
  };
}

/** `readFile` for a caller that only looks and never writes back. */
export async function getFile(versionId: string, path: string): Promise<string> {
  return (await readFile(versionId, path)).content;
}

export async function putFile(
  versionId: string,
  path: string,
  content: string,
  revision: string | null = null,
): Promise<string | null> {
  const res = await client.put<{ ok: boolean; revision?: string | null }>(
    `/api/versions/${seg(versionId)}/files/${filePath(path)}`,
    { content, revision },
  );
  return res?.data?.revision ?? null;
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
  revision: string | null = null,
): Promise<string | null> {
  const res = await client.put<{ ok: boolean; revision?: string | null }>(
    `/api/versions/${seg(versionId)}/csv/${filePath(path)}`,
    { columns, rows, revision },
  );
  return res?.data?.revision ?? null;
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

/**
 * Solver names Pyomo reports as usable where this model's runs will happen.
 *
 * Suggestions, not a whitelist: Calliope accepts any name with a Pyomo
 * interface, so the config editor's field stays free text. Keyed by model
 * rather than global because that is what the answer depends on once a run can
 * be pointed at another Calliope.
 */
export async function getSolvers(versionId: string): Promise<string[]> {
  const res = await client.get<{ solvers: string[] }>(
    `/api/versions/${seg(versionId)}/solvers/`,
  );
  return res.data.solvers;
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

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/** One math source, as `config.init.math_paths` and `extra_math` describe it. */
export interface MathSource {
  name: string;
  kind: "builtin" | "user" | "unknown";
  /** Whether Calliope will read it. A file can be declared and never enabled. */
  applied: boolean;
  /** User math only: the file, workspace-relative. */
  path?: string;
  /** Where the `math_paths` entry itself is written, for a jump-to. */
  file?: string;
  line?: number;
  /** The declared path is not on disk. */
  missing?: boolean;
  /** Has taken a built-in name, and so replaces that whole math file. */
  shadows_builtin?: boolean;
  counts?: Record<string, number>;
}

/** Where a component declared by a user math file is written. */
export interface MathComponentLocation {
  source: string;
  file: string;
  line?: number;
}

export interface MathSourcesPayload {
  sources: MathSource[];
  /** `{group: {name: location}}`, user math only. */
  components: Record<string, Record<string, MathComponentLocation>>;
  fingerprint: string;
}

/** One rendered math component. */
export interface MathComponent {
  name: string;
  group: string;
  title: string;
  description: string;
  unit: string;
  /** KaTeX-ready. Absent for a parameter, which is a symbol with no equation. */
  latex?: string;
  /** The definition as written, defaults omitted. */
  yaml?: string;
  uses: string[];
  used_in: string[];
  /** Every math source defining this name, in the order they are applied. */
  sources: string[];
  /** The last of them: what is actually in effect. */
  origin: string | null;
  overridden: boolean;
  /** `.inf` crosses the wire as a string; JSON cannot carry infinity. */
  default?: number | string | boolean;
  dtype?: string;
  /**
   * Switched off with `active: false`: declared, but not in the formulation.
   *
   * Listed rather than dropped so an author can see their deactivation was
   * picked up, and carrying no `latex`, because there is no notation for a
   * component the model does not contain. Optional so a payload cached before
   * this existed reads as `false`.
   */
  deactivated?: boolean;
}

export interface MathGroup {
  key: string;
  label: string;
  components: MathComponent[];
}

export interface MathPayload {
  mode: string;
  priority: { name: string; kind: "builtin" | "user" }[];
  objective: string;
  groups: MathGroup[];
}

export interface MathEnvelope {
  task_id: string | null;
  status: "running" | "done";
  phase: "math";
  result: MathPayload | null;
  fingerprint?: string;
  error?: string;
}

export async function getMathSources(versionId: string): Promise<MathSourcesPayload> {
  const res = await client.get<MathSourcesPayload>(
    `/api/versions/${seg(versionId)}/math/sources/`,
  );
  return res.data;
}

export async function startMathRender(versionId: string): Promise<MathEnvelope> {
  const res = await client.post<MathEnvelope>(`/api/versions/${seg(versionId)}/math/`);
  return res.data;
}

export async function getMathRender(
  versionId: string,
  taskId: string,
): Promise<MathEnvelope> {
  const res = await client.get<MathEnvelope>(
    `/api/versions/${seg(versionId)}/math/${seg(taskId)}/`,
  );
  return res.data;
}
