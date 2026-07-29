/**
 * Endpoints that belong to the server rather than to any one model: health, the
 * folder browser, the scaffold templates, Calliope's schema, and tasks.
 *
 * `Health` was typed in one of its two callers and untyped in the other, and the
 * untyped one read two fields the typed one does not declare. One declaration,
 * here, is what stops that. `/api/health` was also the only endpoint in the app
 * written without a trailing slash.
 */
import client from "./client";
import { seg } from "./paths";

/** Mirrors `health()` in src/calliope_studio/server/app.py. */
export interface Health {
  status: string;
  /**
   * What the server was started on. The shell switches on this rather than
   * inferring from a null workspace id, which conflated "opened a results file"
   * with "opened a folder that has no model in it".
   */
  mode: "workspace" | "results" | "unknown";
  landing: string;
  capabilities: Partial<{
    edit: boolean;
    run: boolean;
    runs: boolean;
    snapshot: boolean;
  }>;
  workspace: string | null;
  workspace_id: string | null;
  results_handle: string | null;
  run_id: string | null;
  /** Where the recents list lives, shown on the model picker. */
  registry_path: string;
  app_version: string;
}

export async function getHealth(): Promise<Health> {
  const res = await client.get<Health>("/api/health");
  return res.data;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string; is_model: boolean }>;
}

export async function browse(path?: string | null): Promise<FolderListing> {
  const res = await client.get<FolderListing>("/api/browse/", {
    params: path ? { path } : {},
  });
  return res.data;
}

export async function getModelTemplates(): Promise<{
  templates: string[];
  default: string;
}> {
  const res = await client.get<{ templates: string[]; default: string }>(
    "/api/model-templates/",
  );
  return res.data;
}

export async function getCalliopeSchema(): Promise<Record<string, any>> {
  const res = await client.get<Record<string, any>>("/api/schema/calliope/");
  return res.data;
}

// ---------------------------------------------------------------------------
// Tasks — a build started by validation, and the process-group kill that stops it
// ---------------------------------------------------------------------------

export async function getTask<T>(taskId: string): Promise<T> {
  const res = await client.get<T>(`/api/tasks/${seg(taskId)}/`);
  return res.data;
}

export async function cancelTask(taskId: string): Promise<void> {
  await client.post(`/api/tasks/${seg(taskId)}/cancel/`);
}
