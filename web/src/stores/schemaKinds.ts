/**
 * Which Calliope schema each YAML file is validated against.
 *
 * Two inputs. The server **detects** a kind from how Calliope reaches the file —
 * through an `import:` chain, or named in `config.init.math_paths` — which is
 * the same question `modeldef/filekinds.py` answers and the only one that has a
 * correct answer. The user **overrides** it, because detection is a statement
 * about a model that is finished and an editor is where one is not: a file
 * drafted before it is imported is reachable from nothing, and telling the user
 * it is "unknown" is true but unhelpful when they know perfectly well it is
 * math.
 *
 * Overrides are stored client-side, keyed per model the way `stores/tabs.ts`
 * keys its tab set. They are a correction to *our* classifier rather than a
 * property of the model: writing them into the user's YAML would put our
 * bookkeeping in their file, and the server registry is for preferences about
 * this machine's disk.
 *
 * Keyed by path, deliberately. An override has to survive the file being
 * re-detected — adding it to an `import:` list changes what we think it is, and
 * that must not silently throw away what the user said.
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { getSchemaKinds } from "../api/versions";
import { effectiveKind, type FileKind } from "../lib/calliopeSchema";
import { KEY_PREFIX, writeStorage } from "../lib/storageKeys";
import { setSchemaAssignments } from "../monacoSetup";

const storageKey = (id: string) => `${KEY_PREFIX}schemaKind.${id}`;

const VALID: ReadonlySet<string> = new Set<FileKind>(["model", "math", "unknown"]);

function read(id: string): Record<string, FileKind> {
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Entry by entry: a kind written by a future version must not take the rest
    // of this model's overrides down with it.
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (pair): pair is [string, FileKind] =>
          typeof pair[1] === "string" && VALID.has(pair[1]),
      ),
    );
  } catch {
    return {};
  }
}

export const useSchemaKindsStore = defineStore("schemaKinds", () => {
  const detected = ref<Record<string, FileKind>>({});
  const overrides = ref<Record<string, FileKind>>({});
  const versionId = ref<string | null>(null);

  /** What a given file is actually validated against, override included. */
  const kindOf = computed(
    () =>
      (path: string): FileKind =>
        effectiveKind(path, detected.value, overrides.value),
  );

  /** Whether the user, rather than detection, decided this file's kind. */
  const isOverridden = computed(
    () =>
      (path: string): boolean =>
        path in overrides.value,
  );

  async function load(id: string): Promise<void> {
    versionId.value = id;
    overrides.value = read(id);
    try {
      const kinds = await getSchemaKinds<FileKind>(id);
      // A late reply for a model the user has already left must not be applied.
      if (versionId.value !== id) return;
      detected.value = kinds;
    } catch {
      // The same guard as the success path, and for the same reason. Without it
      // a failed request for a model the user has already left wiped the
      // *current* model's kinds — every YAML file lost its schema, so
      // completion and validation went quiet with nothing to say why.
      if (versionId.value !== id) return;
      // No classification is the pre-existing behaviour, minus the wrong schema.
      detected.value = {};
    }
  }

  function override(path: string, kind: FileKind) {
    overrides.value = { ...overrides.value, [path]: kind };
  }

  /** Hands the file back to detection. */
  function clearOverride(path: string) {
    const next = { ...overrides.value };
    delete next[path];
    overrides.value = next;
  }

  function persist() {
    if (!versionId.value) return;
    writeStorage(storageKey(versionId.value), JSON.stringify(overrides.value));
  }

  // Monaco is told on every change to either input, so an override takes effect
  // on the file already open rather than on the next one opened.
  watch(
    [detected, overrides],
    () => {
      persist();
      // Watchers hold no rejection; a failed update would otherwise vanish as
      // an unhandled rejection with schema checking quietly wrong.
      void setSchemaAssignments(detected.value, overrides.value).catch((caught) =>
        console.error("Updating Monaco schema assignments failed:", caught),
      );
    },
    { deep: true },
  );

  return {
    detected,
    overrides,
    versionId,
    kindOf,
    isOverridden,
    load,
    override,
    clearOverride,
  };
});
