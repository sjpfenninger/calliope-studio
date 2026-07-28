import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { KEY_PREFIX } from "../lib/storageKeys";
import { useTabsStore } from "./tabs";
import { useUnitsStore } from "./units";

/**
 * The per-model display units.
 *
 * Worth its own tests because getting the *keying* wrong is invisible until it
 * is expensive: a global key would silently rescale a model in kW by the factor
 * chosen for one in GW, and every number on screen would still look plausible.
 */

const key = (id: string) => `${KEY_PREFIX}units.${id}`;

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe("useUnitsStore", () => {
  it("starts with nothing set, so nothing is scaled or labelled", () => {
    const units = useUnitsStore();
    expect(units.prefs).toEqual({});
    expect(units.isCustomised).toBe(false);
  });

  it("stores a setting under the model it was made for", () => {
    useTabsStore().setVersion("model-a");
    const units = useUnitsStore();
    units.set("energy", { scale: "/1000", label: "GWh" });

    expect(JSON.parse(localStorage.getItem(key("model-a"))!)).toEqual({
      energy: { scale: "/1000", label: "GWh" },
    });
  });

  it("keeps the scale as typed rather than as a number", () => {
    const units = useUnitsStore();
    units.set("energy", { scale: "/1000", label: "GWh" });
    // The field is the user's to read back: "/1000" reappearing as 0.001 is a
    // change they did not make.
    expect(units.prefs.energy?.scale).toBe("/1000");
  });

  it("swaps the whole set when the model changes", async () => {
    const tabs = useTabsStore();
    tabs.setVersion("model-a");
    const units = useUnitsStore();
    units.set("energy", { scale: "/1000", label: "GWh" });

    tabs.setVersion("model-b");
    await nextTick();
    // Model B's numbers must not be divided by a thousand because model A's are.
    expect(units.prefs).toEqual({});

    tabs.setVersion("model-a");
    await nextTick();
    expect(units.prefs.energy).toEqual({ scale: "/1000", label: "GWh" });
  });

  it("falls back to one shared set for a file with no workspace", () => {
    const units = useUnitsStore();
    units.set("power", { scale: "", label: "MW" });
    expect(localStorage.getItem(key("default"))).not.toBeNull();
  });

  it("trims, and clears a quantity set back to nothing", () => {
    useTabsStore().setVersion("m");
    const units = useUnitsStore();
    units.set("energy", { scale: " /1000 ", label: " GWh " });
    expect(units.prefs.energy).toEqual({ scale: "/1000", label: "GWh" });

    units.set("energy", { scale: "  ", label: "" });
    expect(units.prefs.energy).toBeUndefined();
    // An empty set removes the key rather than leaving `{}` behind for every
    // model ever opened.
    expect(localStorage.getItem(key("m"))).toBeNull();
  });

  it("clears everything at once", () => {
    const units = useUnitsStore();
    units.set("energy", { scale: "/1000", label: "GWh" });
    units.set("power", { scale: "", label: "MW" });
    units.clear();
    expect(units.prefs).toEqual({});
    expect(units.isCustomised).toBe(false);
  });

  it("survives a corrupt or half-recognised stored value", () => {
    useTabsStore().setVersion("m");
    localStorage.setItem(key("m"), "{not json");
    expect(useUnitsStore().prefs).toEqual({});

    setActivePinia(createPinia());
    useTabsStore().setVersion("m");
    // A key from a future version, and one whose value is the wrong shape,
    // must not take the rest of the model's settings down with them.
    localStorage.setItem(
      key("m"),
      JSON.stringify({ energy: { scale: "/1000", label: "GWh" }, power: 7, mass: {} }),
    );
    expect(useUnitsStore().prefs).toEqual({
      energy: { scale: "/1000", label: "GWh" },
    });
  });
});
