/**
 * Projects: the registry of models this machine has opened.
 *
 * Two of the field names are the server's and are misleading enough to be worth
 * naming here rather than discovering at a call site: `description` is the
 * model's absolute folder path, and `created_at` is when it was *last opened*,
 * which is what orders the recents list.
 */
import client from "./client";
import { seg } from "./paths";

export interface Project {
  id: string;
  name: string;
  /** The absolute folder path, despite the name. */
  description: string;
  /** When it was last opened, despite the name. */
  created_at: string;
}

export async function listProjects(): Promise<Project[]> {
  const res = await client.get<Project[]>("/api/projects/");
  return res.data;
}

export async function getProject(projectId: string): Promise<Project> {
  const res = await client.get<Project>(`/api/projects/${seg(projectId)}/`);
  return res.data;
}

/** Registers a folder already on disk. */
export async function openProject(path: string): Promise<Project> {
  const res = await client.post<Project>("/api/projects/", { path });
  return res.data;
}

/** Scaffolds from one of Calliope's example models, then registers it. */
export async function createProject(body: {
  parent: string;
  name: string;
  template: string;
}): Promise<Project> {
  const res = await client.post<Project>("/api/projects/new/", body);
  return res.data;
}

/** Drops it from the registry. The folder on disk is untouched. */
export async function forgetProject(projectId: string): Promise<void> {
  await client.delete(`/api/projects/${seg(projectId)}/`);
}

export async function listVersions(projectId: string): Promise<Array<{ id: string }>> {
  const res = await client.get<Array<{ id: string }>>(
    `/api/projects/${seg(projectId)}/versions/`,
  );
  return res.data;
}
