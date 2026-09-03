/**
 * The `localStorage` namespace, and a one-shot rename of the one before it.
 *
 * Every key this application persists is prefixed, so that a rename of the
 * project is a rename of the prefix and nothing else. What is stored under it is
 * not incidental: the theme, the panel geometry, and — per model — which tabs
 * are open. Dropping the lot on a rename would reset every model's tab set,
 * which is state the user built up deliberately.
 *
 * The migration is genuinely one-shot. It renames what it finds and removes the
 * old keys, so the second run has nothing to do; it stays because a browser that
 * has not been opened since the rename is indistinguishable from one that has.
 */

/** Prefix for every key this application writes. */
export const KEY_PREFIX = "calliope-studio.";

/** Prefixes used under earlier names, oldest first. */
export const LEGACY_KEY_PREFIXES = ["calligraph."];

/**
 * Renames any surviving legacy keys into the current namespace.
 *
 * Call before any store reads. A current key already in place wins and the
 * legacy one is discarded rather than merged — the same rule the run-output
 * directory migration uses, for the same reason.
 */
export function migrateLegacyStorageKeys(storage: Storage = localStorage): void {
  try {
    // Snapshot first: `key(i)` is index-based, and the loop below mutates.
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null) keys.push(key);
    }

    for (const key of keys) {
      const prefix = LEGACY_KEY_PREFIXES.find((candidate) => key.startsWith(candidate));
      if (prefix === undefined) continue;

      const renamed = KEY_PREFIX + key.slice(prefix.length);
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(renamed) === null) {
        storage.setItem(renamed, value);
      }
      storage.removeItem(key);
    }
  } catch {
    // A blocked or full localStorage. The app works without any of this.
  }
}

/**
 * Writes one key, or removes it when `value` is null, and never throws.
 *
 * Every *read* in this application was already guarded and most writes were
 * not, which is the wrong way round: a read that throws costs a default, while
 * a write happens from a watcher — the tab set on every tab change, the
 * splitter geometry on every drag frame — and a reactive effect is not a place
 * an exception can be caught. Safari's private mode throws on `setItem` for
 * every origin, and a full quota throws for any of them, so this is the
 * ordinary failure rather than the exotic one.
 *
 * Swallowing is the honest response: everything stored here is a convenience
 * the session already holds in memory, so the only thing lost is that it is
 * still there tomorrow.
 */
export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // A blocked or full localStorage. The value still applies this session.
  }
}
