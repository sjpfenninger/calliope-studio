import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { KEY_PREFIX } from "../lib/storageKeys";
import { useRoundingStore } from "./rounding";
import { useTabsStore } from "./tabs";

/**
 * The per-model display precision.
 *
 * Tested for the reason `units.test.ts` is: the keying is invisible when it is
 * wrong. A global key would carry three significant figures from a model of
 * whole GWh onto one whose costs are fractions, and every number on screen would
 * still look plausible.
 *
 * The other half is `exportPrecision`, which is the only thing standing between
 * a user and a silently lossy CSV.
 */

const key = (id: string) => `${KEY_PREFIX}rounding.${id}`;

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe("useRoundingStore", () => {
  it("starts unset, so nothing anywhere is rounded", () => {
    const rounding = useRoundingStore();
    expect(rounding.digits).toBe("");
    expect(rounding.precision).toBeNull();
    expect(rounding.exportPrecision).toBeNull();
    expect(rounding.isCustomised).toBe(false);
  });

  it("stores a setting under the model it was made for", () => {
    useTabsStore().setVersion("model-a");
    const rounding = useRoundingStore();
    rounding.setDigits("3");

    expect(JSON.parse(localStorage.getItem(key("model-a"))!)).toEqual({
      digits: "3",
      exports: false,
    });
  });

  it("keeps the digits as typed and resolves them separately", () => {
    const rounding = useRoundingStore();
    rounding.setDigits(" 6 ");
    expect(rounding.digits).toBe("6");
    expect(rounding.precision).toBe(6);
  });

  it("does not round while the field is half-typed or wrong", () => {
    const rounding = useRoundingStore();
    rounding.setDigits("abc");
    // Shown as wrong by the panel, but never applied — blanking six figures
    // because someone is mid-keystroke is its own kind of broken.
    expect(rounding.precision).toBeNull();
    // It is still a customisation, so Reset is offered.
    expect(rounding.isCustomised).toBe(true);
  });

  it("swaps the whole setting when the model changes", async () => {
    const tabs = useTabsStore();
    tabs.setVersion("model-a");
    const rounding = useRoundingStore();
    rounding.setDigits("3");

    tabs.setVersion("model-b");
    await nextTick();
    expect(rounding.precision).toBeNull();

    tabs.setVersion("model-a");
    await nextTick();
    expect(rounding.precision).toBe(3);
  });

  it("falls back to one shared setting for a file with no workspace", () => {
    useRoundingStore().setDigits("4");
    expect(localStorage.getItem(key("default"))).not.toBeNull();
  });

  it("leaves the export alone until it is deliberately asked for", () => {
    const rounding = useRoundingStore();
    rounding.setDigits("3");
    // The CSV is what someone does arithmetic on. Setting a display precision
    // must not quietly reach it.
    expect(rounding.precision).toBe(3);
    expect(rounding.exportPrecision).toBeNull();

    rounding.setExports(true);
    expect(rounding.exportPrecision).toBe(3);

    rounding.setExports(false);
    expect(rounding.exportPrecision).toBeNull();
  });

  it("has nothing to apply to an export while the precision is unset", () => {
    const rounding = useRoundingStore();
    rounding.setExports(true);
    expect(rounding.exportPrecision).toBeNull();
  });

  it("removes the key when the setting goes back to nothing", () => {
    useTabsStore().setVersion("m");
    const rounding = useRoundingStore();
    rounding.setDigits("3");
    rounding.setDigits("");
    expect(localStorage.getItem(key("m"))).toBeNull();
  });

  it("clears both halves at once", () => {
    const rounding = useRoundingStore();
    rounding.setDigits("3");
    rounding.setExports(true);
    rounding.clear();
    expect(rounding.digits).toBe("");
    expect(rounding.exports).toBe(false);
    expect(rounding.isCustomised).toBe(false);
  });

  it("survives a corrupt or half-recognised stored value", () => {
    useTabsStore().setVersion("m");
    localStorage.setItem(key("m"), "{not json");
    expect(useRoundingStore().digits).toBe("");

    setActivePinia(createPinia());
    useTabsStore().setVersion("m");
    // A field of the wrong type must not cost the user the other one.
    localStorage.setItem(key("m"), JSON.stringify({ digits: "3", exports: "yes" }));
    const rounding = useRoundingStore();
    expect(rounding.precision).toBe(3);
    expect(rounding.exports).toBe(false);
  });
});
