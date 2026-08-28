import { defineStore } from "pinia";
import { reactive } from "vue";

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
 *
 * `fileRevisions` is the reverse channel, and reactive where the cache is not:
 * a structured save rewrites a file that Monaco may hold a text model for, and
 * that model is a buffer the next raw Cmd+S writes back — stale, it reverts
 * the structured save. Every section write bumps its file's revision, and
 * `MonacoYamlEditor` watches it to reload clean buffers from disk.
 */
export const useSectionDataStore = defineStore("sectionData", () => {
  const cache = new Map<string, Record<string, any>>();

  /** Model-relative path → how many times a section write has landed on it. */
  const fileRevisions = reactive(new Map<string, number>());

  /** Records that a write outside Monaco's own buffers changed `filePath`. */
  function noteFileWritten(filePath: string): void {
    fileRevisions.set(filePath, (fileRevisions.get(filePath) ?? 0) + 1);
  }

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

  return { get, set, invalidate, invalidateFile, fileRevisions, noteFileWritten };
});
