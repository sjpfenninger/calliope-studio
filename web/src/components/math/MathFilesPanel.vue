<script setup lang="ts">
/**
 * The math files a model declares, and whether Calliope reads them.
 *
 * This is the half of custom math that had no interface at all. `math_paths` and
 * `extra_math` are both marked `ownedBy` in `ConfigEditor`, so that form shows
 * their values and refuses to write them. **The reason is single-writer
 * ownership, not rendering** — `SchemaObjectEditor` can draw a name→path mapping
 * and a list of names perfectly well now, and the note that said otherwise is
 * how somebody would come to add a second writer. See the paragraph below on
 * what that would cost.
 *
 * **Declaring and enabling are two acts, and the gap between them is the trap.**
 * `math_paths` registers a name against a file; `extra_math` lists the names to
 * apply. A file registered and never enabled is read by nobody, and Calliope
 * says nothing at all about it, because from its point of view you did not ask.
 * The toggle here is the second act, named as such.
 *
 * **Every action writes immediately** rather than going through
 * `useSectionEditor`. A math tab is `isDirty: false` by construction and has no
 * buffer to mark, and more to the point a toggle *is* an action — there is no
 * half-typed intermediate state for a Save button to protect.
 *
 * Writing `config` from here is safe against the config editor, but no longer
 * for the reason this note used to give. `TabBody` mounted only the **active**
 * structured editor, so a config editor was never alive while this panel was on
 * screen and re-read on its next mount — at the cost of destroying the unsaved
 * edits in every backgrounded form, which is why the panes are now `v-show`n
 * and kept. What carries the write across instead is `sectionData`'s
 * `fileRevisions`: `putYamlSection` here bumps it and `useSectionEditor`
 * reloads any *clean* form for the same file. A form the user has unsaved edits
 * in is deliberately not reloaded — their buffer wins, and it would save a
 * stale `config` back over these settings, which is the one case left. It is
 * the lesser of the two, and the one that is visible on screen.
 *
 * `math-check` pins the property from the outside, so the arrangement is
 * checked rather than reasoned about again.
 */
import { computed, ref } from "vue";
import { FilePlus2, Trash2 } from "@lucide/vue";

import Eyebrow from "@/components/app/Eyebrow.vue";
import { Switch } from "@/components/ui/switch";
import { errorDetail } from "@/api/errors";
import {
  createFile,
  getYamlSection,
  putFile,
  putYamlSection,
  type SectionData,
} from "@/api/versions";
import { FIELD_SM, GHOST_BUTTON, DANGER_ICON_BUTTON_SM } from "@/lib/formClasses";
import { sectionTabId } from "@/lib/tabId";
import { useConfirmStore } from "@/stores/confirm";
import { useComponentTreeStore } from "@/stores/componentTree";
import { useMathStore } from "@/stores/math";
import { useSectionDataStore } from "@/stores/sectionData";
import { useTabsStore } from "@/stores/tabs";
import { useVersionStore } from "@/stores/version";
import type { MathSource } from "@/api/versions";

const props = defineProps<{ versionId: string }>();

const math = useMathStore();
const tabs = useTabsStore();
const confirm = useConfirmStore();
const sectionData = useSectionDataStore();
const componentTree = useComponentTreeStore();
const version = useVersionStore();

const busy = ref(false);
const error = ref<string | null>(null);
const adding = ref(false);
const newName = ref("");

/** Only the user's own files: a built-in source has nothing to configure. */
const files = computed(() => math.sources.filter((source) => source.kind === "user"));

/** Names in `extra_math` that nothing declares — Calliope refuses to read these. */
const undefinedNames = computed(() =>
  math.sources.filter((source) => source.kind === "unknown"),
);

/** The file whose `config:` section declares the math, or the model root. */
function configFile(): string {
  return componentTree.tree?.config?.file ?? "model.yaml";
}

/**
 * Reads `config`, applies a change, writes it back and reloads.
 *
 * The whole section, as `ConfigEditor.buildPayload` also writes it: the server's
 * merge is leaf-level, so a key removed from a nested mapping has to be absent
 * from a *whole* write to actually go away.
 */
async function edit(change: (init: SectionData) => void): Promise<boolean> {
  if (busy.value) return false;
  busy.value = true;
  error.value = null;
  const path = configFile();
  try {
    const config: SectionData = await getYamlSection(props.versionId, path, "config");
    config.init = { ...(config.init ?? {}) };
    change(config.init);
    await putYamlSection(props.versionId, path, "config", config);
    sectionData.invalidate(props.versionId, path, "config");
    // A raw Monaco model of the config file is stale now too.
    sectionData.noteFileWritten(path);
    // The config editor may be showing the previous values in another tab.
    tabs.markClean(sectionTabId("config", path));
    await Promise.all([math.loadSources(props.versionId), componentTree.refresh(props.versionId)]);
    return true;
  } catch (err) {
    error.value = errorDetail(err, "Could not update the model's math settings.");
    return false;
  } finally {
    busy.value = false;
  }
}

function toggle(source: MathSource, enabled: boolean) {
  void edit((init) => {
    const applied: string[] = [...((init.extra_math as string[]) ?? [])];
    const at = applied.indexOf(source.name);
    if (enabled && at === -1) applied.push(source.name);
    if (!enabled && at !== -1) applied.splice(at, 1);
    init.extra_math = applied;
  });
}

async function remove(source: MathSource) {
  const ok = await confirm.ask({
    title: `Stop using ${source.name}?`,
    message:
      `This removes the entry from config.init.math_paths and config.init.extra_math. ` +
      `${source.path ?? "The file"} itself is left on disk.`,
    confirmLabel: "Remove",
    destructive: true,
  });
  if (!ok) return;

  void edit((init) => {
    const paths = { ...((init.math_paths as Record<string, string>) ?? {}) };
    delete paths[source.name];
    init.math_paths = paths;
    init.extra_math = ((init.extra_math as string[]) ?? []).filter(
      (name) => name !== source.name,
    );
  });
}

/** A skeleton that parses, validates and does nothing until it is edited. */
const STARTER = `# Custom math for this model. See
# https://calliope.readthedocs.io/en/v0.7.0.dev7/user_defined_math/
constraints: {}
`;

async function create() {
  const name = newName.value.trim();
  if (!name || busy.value) return;

  const path = `${name}.yaml`;
  busy.value = true;
  error.value = null;
  try {
    // The file first: registering a path that is not there would leave the model
    // in the one state the tree flags as broken.
    await createFile(props.versionId, path);
    await putFile(props.versionId, path, STARTER);
  } catch (err) {
    error.value = errorDetail(err, `Could not create ${path}.`);
    busy.value = false;
    return;
  }
  busy.value = false;

  // The new file has to appear in the Files tree, whichever way the config
  // write below goes — it is on disk either way.
  void version.loadFileTree(props.versionId).catch(() => {});

  const registered = await edit((init) => {
    init.math_paths = { ...((init.math_paths as Record<string, string>) ?? {}), [name]: path };
    const applied: string[] = [...((init.extra_math as string[]) ?? [])];
    if (!applied.includes(name)) applied.push(name);
    init.extra_math = applied;
  });
  // The form stays open on failure: closing it and moving on is the success
  // gesture, and the model is currently in the registered-nowhere state the
  // panel's own error line is describing.
  if (!registered) return;

  adding.value = false;
  newName.value = "";
  // Straight into the editor: an empty math file is not the end of the task.
  tabs.openFile(path);
}
</script>

<template>
  <div class="flex flex-col gap-1 border-b border-border-subtle px-2 py-1.5" data-testid="math-files">
    <div class="flex items-center gap-1">
      <Eyebrow class="mb-0">Math files</Eyebrow>
      <div class="flex-1" />
      <button
        type="button"
        :class="GHOST_BUTTON"
        data-testid="math-new-file"
        :disabled="busy"
        @click="adding = !adding"
      >
        <FilePlus2 class="size-3.5" />
        New
      </button>
    </div>

    <!-- A plain paragraph rather than `StateMessage`: that component's `inline`
         variant is padded for a list row, and this is a note under a heading in
         a 256px sidebar. -->
    <p v-if="error" class="text-2xs text-danger-text">{{ error }}</p>

    <form v-if="adding" class="flex items-center gap-1" @submit.prevent="create">
      <input
        v-model="newName"
        :class="FIELD_SM"
        data-testid="math-new-name"
        placeholder="my_math"
        aria-label="Name for the new math file"
      />
      <button type="submit" :class="GHOST_BUTTON" :disabled="!newName.trim() || busy">
        Create
      </button>
    </form>

    <p v-if="!files.length && !adding" class="text-2xs text-text-faint">
      No custom math. New creates a file and enables it.
    </p>

    <div
      v-for="source in files"
      :key="source.name"
      class="flex items-center gap-1"
      :data-math-file="source.name"
    >
      <Switch
        :model-value="source.applied"
        :disabled="busy || source.missing"
        :aria-label="`Apply ${source.name}`"
        @update:model-value="(value: boolean) => toggle(source, value)"
      />
      <button
        type="button"
        class="min-w-0 flex-1 truncate text-left text-sm"
        :class="source.applied ? 'text-foreground' : 'text-text-faint'"
        :disabled="!source.path || source.missing"
        @click="source.path && tabs.openFile(source.path)"
      >
        {{ source.name }}
      </button>
      <span v-if="source.missing" class="shrink-0 text-2xs text-warning-text">
        missing
      </span>
      <button
        type="button"
        :class="DANGER_ICON_BUTTON_SM"
        :disabled="busy"
        :aria-label="`Stop using ${source.name}`"
        @click="remove(source)"
      >
        <Trash2 class="size-3" />
      </button>
    </div>

    <!-- Listed in `extra_math` and declared nowhere. Calliope raises
         `Requested math '…' was not initialised.` and refuses to read the model
         at all, so this is worth more than a tree badge. -->
    <p
      v-for="source in undefinedNames"
      :key="source.name"
      class="text-2xs text-danger-text"
    >
      “{{ source.name }}” is in extra_math but declared nowhere.
    </p>
  </div>
</template>
