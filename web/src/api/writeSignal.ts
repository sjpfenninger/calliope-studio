/**
 * "Something was written to the model" — one signal, from one place.
 *
 * The version-tracking store has to re-read git's status after any write to
 * the model folder: a raw save, a structured save, a data-table save, a file
 * created or deleted, a run started with "commit first". Those happen in
 * seven stores and components, and each already announces itself to the
 * *editors* through `stores/sectionData.ts::noteFileWritten` — a per-file
 * reload channel, which is the wrong shape here and would still miss a
 * delete and a create. `api/client.ts` is a bare axios instance, so a
 * response interceptor is a genuine single point: every request goes through
 * `api/`, and a successful non-GET to `/api/versions/…` *is* a write.
 *
 * The listener set lives here rather than in the store so the client does
 * not import a store, which would import the client back.
 */
import type { AxiosInstance, AxiosResponse } from "axios";

type Listener = () => void;

const listeners = new Set<Listener>();

const READ_METHODS = new Set(["get", "head", "options"]);

/** Whether a response was to a request that could have changed the model. */
export function isVersionWrite(
  config: { method?: string; url?: string } | undefined,
): boolean {
  if (!config?.url) return false;
  const method = (config.method ?? "get").toLowerCase();
  return !READ_METHODS.has(method) && config.url.includes("/api/versions/");
}

/** Subscribes; returns the unsubscribe. */
export function onVersionWrite(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Installs the interceptor. Called once, from `api/client.ts`.
 *
 * Only a *successful* response counts: a refused write changed nothing, and
 * a 409 from a stale save is exactly the case a refresh would misreport.
 */
export function installWriteSignal(client: Pick<AxiosInstance, "interceptors">): void {
  client.interceptors.response.use((response: AxiosResponse) => {
    if (isVersionWrite(response.config)) notify();
    return response;
  });
}
