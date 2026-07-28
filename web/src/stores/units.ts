/**
 * What this model's quantities are really measured in.
 *
 * Calliope declares that `flow_out` is "energy"; only the modeller knows the
 * input data is in MWh and that they would rather read GWh. That is a fact
 * about *one model's* data, so it is stored per model, keyed the same way
 * `stores/tabs.ts` keys its tab set — two models in different base units must
 * not share a setting, and changing models must not silently rescale the one
 * you have just opened.
 *
 * Kept as the user typed it. `/1000` round-trips as `/1000` rather than
 * reappearing as 0.001, because the field is theirs to read back.
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { KEY_PREFIX } from "../lib/storageKeys";
import { QUANTITIES, type Quantity, type UnitPref, type UnitPrefs } from "../lib/units";
import { useTabsStore } from "./tabs";

/**
 * Where a model with no workspace keeps its units.
 *
 * A `.nc` opened straight from the command line has no version id to key on.
 * One shared bucket for all of them beats no setting at all, and it is the only
 * case where two models can share one.
 */
const FALLBACK_ID = "default";

const storageKey = (id: string) => `${KEY_PREFIX}units.${id}`;

function isPref(value: unknown): value is UnitPref {
  const pref = value as UnitPref | null;
  return (
    typeof pref === "object" &&
    pref !== null &&
    typeof pref.scale === "string" &&
    typeof pref.label === "string"
  );
}

function read(id: string): UnitPrefs {
  const prefs: UnitPrefs = {};
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (!raw) return prefs;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Validated entry by entry rather than wholesale: a key that has since been
    // dropped from `QUANTITIES`, or a value written by a future version, must
    // not take the rest of the model's settings down with it.
    for (const quantity of QUANTITIES) {
      if (isPref(parsed?.[quantity])) prefs[quantity] = parsed[quantity];
    }
    return prefs;
  } catch {
    return prefs;
  }
}

export const useUnitsStore = defineStore("units", () => {
  const tabs = useTabsStore();

  const modelId = computed(() => tabs.versionId || FALLBACK_ID);
  const prefs = ref<UnitPrefs>(read(modelId.value));

  // Switching models swaps the whole set, rather than carrying the last model's
  // units onto the next one's numbers.
  watch(modelId, (id) => {
    prefs.value = read(id);
  });

  function persist() {
    try {
      const id = modelId.value;
      // An empty set is a removal, so a model reverts to no key at all rather
      // than accumulating `{}` for every model ever opened.
      if (!Object.keys(prefs.value).length) localStorage.removeItem(storageKey(id));
      else localStorage.setItem(storageKey(id), JSON.stringify(prefs.value));
    } catch {
      // A blocked or full localStorage. The setting still applies this session.
    }
  }

  /** Sets one quantity's scale and label; clears it when both are empty. */
  function set(quantity: Quantity, pref: UnitPref) {
    const scale = pref.scale.trim();
    const label = pref.label.trim();
    const current = prefs.value[quantity];
    if (current?.scale === scale && current?.label === label) return;

    const next: UnitPrefs = { ...prefs.value };
    if (!scale && !label) delete next[quantity];
    else next[quantity] = { scale, label };
    prefs.value = next;
    persist();
  }

  function clear() {
    if (!Object.keys(prefs.value).length) return;
    prefs.value = {};
    persist();
  }

  const isCustomised = computed(() => Object.keys(prefs.value).length > 0);

  return { prefs, modelId, isCustomised, set, clear };
});
