import { defineStore } from "pinia";

/**
 * Lightweight read-through cache for YAML section data.
 *
 * Key: `${versionId}:${filePath}:${section}`
 * Value: the raw JSON object returned by GET /api/versions/.../yaml-section/...
 *
 * Cache is intentionally a plain Map (not reactive) — components use it
 * only inside load() and never need to react to cache mutations.
 *
 * Invalidation:
 *  - After a structured editor saves → set() is called with the new payload
 *  - After a Monaco file/virtual save → invalidate() / invalidateFile() clears stale entries
 */
export const useSectionDataStore = defineStore("sectionData", () => {
  const cache = new Map<string, Record<string, any>>();

  function cacheKey(versionId: string, filePath: string, section: string): string {
    return `${versionId}:${filePath}:${section}`;
  }

  function get(
    versionId: string,
    filePath: string,
    section: string
  ): Record<string, any> | null {
    return cache.get(cacheKey(versionId, filePath, section)) ?? null;
  }

  function set(
    versionId: string,
    filePath: string,
    section: string,
    data: Record<string, any>
  ): void {
    cache.set(cacheKey(versionId, filePath, section), data);
  }

  /** Remove one section entry (e.g. after a virtual-tab raw save). */
  function invalidate(versionId: string, filePath: string, section: string): void {
    cache.delete(cacheKey(versionId, filePath, section));
  }

  /** Remove all cached sections for a file (e.g. after a Monaco file save). */
  function invalidateFile(versionId: string, filePath: string): void {
    const prefix = `${versionId}:${filePath}:`;
    for (const k of [...cache.keys()]) {
      if (k.startsWith(prefix)) cache.delete(k);
    }
  }

  return { get, set, invalidate, invalidateFile };
});
