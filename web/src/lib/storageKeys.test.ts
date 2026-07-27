import { beforeEach, describe, expect, it } from "vitest";

import {
  KEY_PREFIX,
  LEGACY_KEY_PREFIXES,
  migrateLegacyStorageKeys,
} from "./storageKeys";

const [LEGACY] = LEGACY_KEY_PREFIXES;

describe("migrateLegacyStorageKeys", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renames a legacy key into the current namespace", () => {
    localStorage.setItem(`${LEGACY}theme`, "dark");

    migrateLegacyStorageKeys();

    expect(localStorage.getItem(`${KEY_PREFIX}theme`)).toBe("dark");
    expect(localStorage.getItem(`${LEGACY}theme`)).toBeNull();
  });

  it("carries the per-model tab sets across", () => {
    // The suffix is a minted tab-set id, so the rename cannot enumerate names.
    localStorage.setItem(`${LEGACY}tabs.abc123`, '{"tabs":["f:model.yaml"]}');
    localStorage.setItem(`${LEGACY}tabs.def456`, '{"tabs":[]}');

    migrateLegacyStorageKeys();

    expect(localStorage.getItem(`${KEY_PREFIX}tabs.abc123`)).toBe(
      '{"tabs":["f:model.yaml"]}',
    );
    expect(localStorage.getItem(`${KEY_PREFIX}tabs.def456`)).toBe('{"tabs":[]}');
  });

  it("does not overwrite a key that already exists", () => {
    localStorage.setItem(`${LEGACY}theme`, "dark");
    localStorage.setItem(`${KEY_PREFIX}theme`, "light");

    migrateLegacyStorageKeys();

    expect(localStorage.getItem(`${KEY_PREFIX}theme`)).toBe("light");
    expect(localStorage.getItem(`${LEGACY}theme`)).toBeNull();
  });

  it("leaves keys belonging to anything else alone", () => {
    localStorage.setItem("someone-elses.theme", "dark");

    migrateLegacyStorageKeys();

    expect(localStorage.getItem("someone-elses.theme")).toBe("dark");
  });

  it("is a no-op the second time", () => {
    localStorage.setItem(`${LEGACY}theme`, "dark");

    migrateLegacyStorageKeys();
    localStorage.setItem(`${KEY_PREFIX}theme`, "light");
    migrateLegacyStorageKeys();

    expect(localStorage.getItem(`${KEY_PREFIX}theme`)).toBe("light");
  });

  it("survives a storage that throws", () => {
    const blocked = {
      get length(): number {
        throw new Error("denied");
      },
    } as unknown as Storage;

    expect(() => migrateLegacyStorageKeys(blocked)).not.toThrow();
  });
});
