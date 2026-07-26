/**
 * Test environment shims.
 *
 * `localStorage` is missing under the test DOM even though `sessionStorage` is
 * present: Node 26 declares a flag-gated `localStorage` global, which shadows the
 * one the DOM implementation would otherwise provide. Node says so itself when
 * the tests run —
 *
 *     ExperimentalWarning: localStorage is not available because
 *     --localstorage-file was not provided.
 *
 * Browsers are unaffected — `npm run token-check` exercises the real thing — but
 * every store that persists a preference would fail to construct here.
 *
 * A minimal in-memory Storage rather than reaching for another DOM
 * implementation: the only behaviour that matters is that values come back as
 * strings, which is exactly what trips up code that stores a number or an object.
 */
class MemoryStorage implements Storage {
  private entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    return this.entries.has(key) ? (this.entries.get(key) as string) : null;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    // Coerced, as a real Storage does. Without this a test could store a number
    // and read a number back, hiding a bug that only shows in a browser.
    this.entries.set(String(key), String(value));
  }
}

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}
