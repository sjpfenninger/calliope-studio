<script setup lang="ts">
/**
 * Overrides, as the settings each one makes.
 *
 * An override is an *arbitrary partial model*: it can set anything the model can
 * — `config`, `data_tables`, `techs`, `nodes` — at any depth, in nested or dotted
 * form, freely mixed. A fully structured form for one would be the entire editor
 * again, recursively, which is the trap this deliberately avoids.
 *
 * So: one row per leaf, `path` and `value`. That is how Calliope reads them
 * anyway, it handles arbitrary depth with no bespoke form per section, and it
 * makes the one question a user actually has — *what does this override change?*
 * — answerable at a glance.
 *
 * Displaying flattened does **not** mean writing flattened. The server applies
 * each path against the structure already in the file, so an override written as
 * nested YAML stays nested and a dotted key keeps its spelling. That is why this
 * editor talks to `/overrides/` rather than to `yaml-section`.
 */
import { computed, ref } from "vue";
import LockedBanner from "@/components/app/LockedBanner.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import {
  duplicateNameError,
  duplicateNames,
  rememberName,
  renamesFor,
  rowKey,
} from "@/lib/entries";
import { usePinnedEntry } from "@/composables/usePinnedEntry";
import { Plus, X } from "@lucide/vue";

import { putOverrides, readOverrides } from "@/api/versions";
import { useSectionEditor } from "@/composables/useSectionEditor";
import EditorToolbar from "./EditorToolbar.vue";
import ScalarOrDataVar from "./ScalarOrDataVar.vue";
import { Accordion } from "@/components/ui/accordion";
import EntryAccordionRow from "./EntryAccordionRow.vue";
import FieldRow from "@/components/app/FieldRow.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import { FIELD, GHOST_BUTTON } from "@/lib/formClasses";
import { formatCount } from "@/lib/format";
import { useFocusNew } from "./focusNew";

import { cn } from "@/lib/utils";
import { useComponentTreeStore } from "@/stores/componentTree";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabId: string;
  entryName?: string | null;
}>();

const componentTree = useComponentTreeStore();

interface Setting {
  path: string;
  value: any;
}

interface OverrideEntry {
  name: string;
  settings: Setting[];
}

const entries = ref<OverrideEntry[]>([]);
/**
 * Which rows are expanded, by `rowKey`. State rather than Reka's
 * `:default-value`, which is read once; extended by `addEntry`.
 */
const openRows = ref<string[]>([]);
/** The field a row just added exists to fill in takes the cursor; see `focusNew`. */
const focus = useFocusNew();

// On an entry tab, the one entry — by identity, so renaming it keeps it.
const { visible: visibleEntries } = usePinnedEntry(entries, () => props.entryName);

/**
 * Paths worth suggesting, drawn from the model's own entities.
 *
 * Free text stays allowed — an override can set things no schema enumerates —
 * but a datalist turns "what is this called again?" into a menu.
 */
const suggestions = computed(() => {
  const tree = componentTree.tree;
  const paths = [
    "config.init.name",
    "config.init.subset.timesteps",
    "config.init.resample.timesteps",
    "config.build.ensure_feasibility",
    "config.solve.solver",
  ];
  for (const section of ["techs", "nodes"] as const) {
    for (const entry of tree?.[section]?.entries ?? []) {
      const name = typeof entry === "string" ? entry : entry.name;
      paths.push(`${section}.${name}.`);
    }
  }
  return paths;
});

/**
 * Overrides are not served through `yaml-section`, so this is the one editor
 * that supplies its own transport. Everything else about it is identical.
 */
const {
  isLoading,
  isSaving,
  error,
  saveError,
  conflict,
  locked,
  lockOwner,
  save,
  reload,
  markDirty,
} = useSectionEditor({
  versionId: () => props.versionId,
  filePath: () => props.filePath,
  tabId: () => props.tabId,
  section: "overrides",
  label: "overrides",
  transport: {
    read: (versionId, path) => readOverrides<Setting>(versionId, path),
    write: (versionId, path, data, revision, renames) =>
      putOverrides<Setting>(
        versionId,
        path,
        data as Record<string, Setting[]>,
        revision,
        renames,
      ),
  },
  async apply(data) {
    entries.value = Object.entries(data as Record<string, Setting[]>).map(
      ([name, settings]) => ({
        name,
        settings: settings.map((setting) => ({ ...setting })),
      }),
    );
    for (const entry of entries.value) rememberName(entry, entry.name);
    openRows.value = entries.value.map(rowKey);
    // The path suggestions read the tree, and only the explorer used to load
    // it — so an overrides tab in front on a URL that opens on Files or Runs
    // suggested the five config paths and nothing of the model's own. Cheap:
    // the store returns immediately once loaded, and the explorer usually has.
    await componentTree.load(props.versionId);
  },
  // A path that cannot exist — `config.init.name.deeper`, where `name` holds a
  // string — comes back as a 400 saying so, and nothing was written.
  build: () => {
    const repeated = duplicateNames(entries.value);
    if (repeated.length) throw duplicateNameError(repeated, "overrides");
    return Object.fromEntries(
      entries.value
        .filter((entry) => entry.name)
        .map((entry) => [
          entry.name,
          entry.settings.filter((setting) => setting.path.trim()),
        ]),
    );
  },
  renames: () => renamesFor(entries.value),
  async after(written) {
    // The file now says each row's current name, so a later rename is
    // measured from that.
    if (written) {
      for (const entry of entries.value) {
        if (entry.name) rememberName(entry, entry.name);
      }
    }
    // The explorer's `overrides` branch, and ScenariosEditor's "declared
    // nowhere" check, both read the component tree — a new override has to
    // reach it or the save reads as having failed.
    await componentTree.refresh(props.versionId);
  },
});

function addEntry() {
  entries.value.push({ name: "", settings: [] });
  const key = rowKey(entries.value[entries.value.length - 1]);
  openRows.value = [...openRows.value, key];
  focus.request(key);
  onChange();
}

function removeEntry(entry: OverrideEntry) {
  const at = entries.value.indexOf(entry);
  if (at !== -1) entries.value.splice(at, 1);
  onChange();
}

function addSetting(entry: OverrideEntry) {
  entry.settings.push({ path: "", value: null });
  focus.request(rowKey(entry.settings[entry.settings.length - 1]));
  onChange();
}

function removeSetting(entry: OverrideEntry, setting: Setting) {
  const at = entry.settings.indexOf(setting);
  if (at !== -1) entry.settings.splice(at, 1);
  onChange();
}

/** What removing this override takes with it, for the confirmation. */
function owns(entry: OverrideEntry): string {
  return entry.settings.length ? formatCount(entry.settings.length, "setting") : "";
}

const onChange = markDirty;
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="overrides-editor">
    <StateMessage v-if="isLoading" variant="block" loading>
      Loading overrides…
    </StateMessage>
    <!-- In place of the form, as every other editor does. This one used to
         render the error as a banner *under* the toolbar, Save button and all —
         and a save over the empty form it left wrote `{}`, which deleted every
         override in the file. -->
    <StateMessage v-else-if="error" variant="block" tone="danger">{{ error }}</StateMessage>

    <template v-else>
      <EditorToolbar
        :saving="isSaving"
        :disabled="locked"
        :error="saveError"
        :conflict="conflict"
        :file="filePath"
        :tab-id="tabId"
        @save="save"
        @reload="reload"
      >
        <button
          v-if="!entryName"
          type="button"
          data-testid="add-override"
          :class="GHOST_BUTTON"
          :disabled="locked"
          @click="addEntry"
        >
          <Plus class="size-3.5" />
          Add override
        </button>
      </EditorToolbar>
      <LockedBanner v-if="lockOwner" :owner="lockOwner" :file="filePath" />

      <fieldset :disabled="locked" class="min-h-0 flex-1 overflow-auto">
        <StateMessage v-if="!visibleEntries.length" variant="block">
          {{
            entryName
              ? `No override called “${entryName}”.`
              : "No overrides defined yet."
          }}
          <template v-if="!entryName" #action>
            <button type="button" :class="GHOST_BUTTON" :disabled="locked" @click="addEntry">
              <Plus class="size-3.5" />
              Add override
            </button>
          </template>
        </StateMessage>

        <Accordion v-else v-model="openRows" type="multiple" class="px-2 py-1">
          <EntryAccordionRow
            v-for="entry in visibleEntries"
            :key="rowKey(entry)"
            :value="rowKey(entry)"
            :name="entry.name || '(unnamed)'"
            remove-label="Remove this override"
            :owns="owns(entry)"
            testid="entry-row"
            @remove="removeEntry(entry)"
          >
            <template #meta>
              <span class="shrink-0 text-2xs text-text-muted">
                {{ formatCount(entry.settings.length, "setting") }}
              </span>
            </template>

            <FieldRow label="name" width="short">
              <input
                v-model="entry.name"
                type="text"
                :ref="(el) => focus.bind(el, rowKey(entry))"
                :class="FIELD"
                @input="onChange"
              />
            </FieldRow>

            <!-- The wide gutter, because these keys are paths: at the
                 standard 9rem, `config.solve.spores.number` and
                 `config.solve.spores.tracking_parameter` truncate to the
                 same string. -->
            <!-- Keyed by the setting's own identity, never by its index: the
                 value control seeds its text at setup, so a reused instance
                 kept the removed row's number under the next row's path. -->
            <FieldRow
              v-for="setting in entry.settings"
              :key="rowKey(setting)"
              :label="setting.path"
              width="value"
              align="start"
              gutter="wide"
              data-testid="override-setting"
            >
              <template #label>
                <!-- design-check: allow native-title — the field's own
                     value, which a 16rem gutter still clips. -->
                <input
                  v-model="setting.path"
                  type="text"
                  list="override-paths"
                  placeholder="config.init.name"
                  :title="setting.path"
                  :ref="(el) => focus.bind(el, rowKey(setting))"
                  :class="FIELD"
                  @input="onChange"
                />
              </template>

              <!-- Not every value is a scalar: `spores_tracker` is a whole
                   indexed parameter, and the same control the tech editor
                   uses handles both without mangling either. -->
              <ScalarOrDataVar
                :model-value="setting.value"
                @update:model-value="
                  setting.value = $event;
                  onChange();
                "
              />

              <template #action>
                <TooltipButton
                  label="Remove this setting"
                  :icon="X"
                  tone="danger"
                  size="xs"
                  @click="removeSetting(entry, setting)"
                />
              </template>
            </FieldRow>

            <button
              type="button"
              :class="cn(GHOST_BUTTON, 'self-start')"
              @click="addSetting(entry)"
            >
              <Plus class="size-3.5" />
              Add setting
            </button>
          </EntryAccordionRow>
        </Accordion>

        <datalist id="override-paths">
          <option v-for="path in suggestions" :key="path" :value="path" />
        </datalist>
      </fieldset>
    </template>
  </div>
</template>
