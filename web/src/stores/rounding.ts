/**
 * How many digits of this model's results the reader wants to see.
 *
 * The same kind of fact as `stores/units.ts`, so it is kept the same way: a
 * display preference about *one model's* numbers, keyed per model and persisted
 * per model. A model whose flows are whole GWh wants three significant figures;
 * one whose costs are fractions wants six, and neither answer should follow the
 * user into the other model.
 *
 * A *sibling* key rather than a field inside the units record. Extending that
 * record would mean migrating every model's stored units to a nested shape for
 * no gain, and it would tangle two Reset buttons together — resetting the units
 * would silently reset the precision with them.
 *
 * The digit count is kept as the user typed it, for the reason the unit scale
 * is: the field is theirs to read back.
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { parsePrecision } from "../lib/precision";
import { KEY_PREFIX } from "../lib/storageKeys";
import { useTabsStore } from "./tabs";

/** Where a `.nc` opened with no workspace keeps its setting. See `units.ts`. */
const FALLBACK_ID = "default";

const storageKey = (id: string) => `${KEY_PREFIX}rounding.${id}`;

/** What is persisted. `digits` is text because it is what the user typed. */
interface RoundingPref {
  digits: string;
  exports: boolean;
}

const EMPTY: RoundingPref = { digits: "", exports: false };

function read(id: string): RoundingPref {
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<RoundingPref> | null;
    // Field by field rather than wholesale, as `units.ts` reads its quantities:
    // a value written by a future version must not cost the user the other one.
    return {
      digits: typeof parsed?.digits === "string" ? parsed.digits : "",
      exports: parsed?.exports === true,
    };
  } catch {
    return EMPTY;
  }
}

const isEmpty = (pref: RoundingPref) => !pref.digits && !pref.exports;

export const useRoundingStore = defineStore("rounding", () => {
  const tabs = useTabsStore();

  const modelId = computed(() => tabs.versionId || FALLBACK_ID);
  const pref = ref<RoundingPref>(read(modelId.value));

  watch(modelId, (id) => {
    pref.value = read(id);
  });

  function persist() {
    try {
      const id = modelId.value;
      // Nothing set is no key at all, rather than a default record accumulating
      // for every model ever opened.
      if (isEmpty(pref.value)) localStorage.removeItem(storageKey(id));
      else localStorage.setItem(storageKey(id), JSON.stringify(pref.value));
    } catch {
      // A blocked or full localStorage. The setting still applies this session.
    }
  }

  function update(next: RoundingPref) {
    const digits = next.digits.trim();
    const exports = next.exports;
    if (pref.value.digits === digits && pref.value.exports === exports) return;
    pref.value = { digits, exports };
    persist();
  }

  const digits = computed(() => pref.value.digits);
  const exports = computed(() => pref.value.exports);

  function setDigits(value: string) {
    update({ digits: value, exports: pref.value.exports });
  }

  function setExports(value: boolean) {
    update({ digits: pref.value.digits, exports: value });
  }

  function clear() {
    if (isEmpty(pref.value)) return;
    pref.value = { ...EMPTY };
    persist();
  }

  /**
   * What every *display* surface rounds by — the table, both charts, the map.
   *
   * Null while the field is empty or half-typed, which is what leaves the app
   * showing exactly what it showed before there was a setting.
   */
  const precision = computed(() => parsePrecision(pref.value.digits));

  /**
   * What every *export* rounds by, which is nothing unless asked.
   *
   * A CSV is what someone puts in a paper and does arithmetic on, so trimming it
   * is a loss they have to ask for. The policy lives here rather than at the four
   * export buttons, so it cannot be half-applied.
   */
  const exportPrecision = computed(() =>
    pref.value.exports ? precision.value : null,
  );

  const isCustomised = computed(() => !isEmpty(pref.value));

  return {
    digits,
    exports,
    modelId,
    precision,
    exportPrecision,
    isCustomised,
    setDigits,
    setExports,
    clear,
  };
});
