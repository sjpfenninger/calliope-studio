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
import { rowKey } from "@/lib/entries";
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

const visibleEntries = computed(() =>
  props.entryName
    ? entries.value.filter((entry) => entry.name === props.entryName)
    : entries.value,
);

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
    write: (versionId, path, data, revision) =>
      putOverrides<Setting>(
        versionId,
        path,
        data as Record<string, Setting[]>,
        revision,
      ),
  },
  apply(data) {
    entries.value = Object.entries(data as Record<string, Setting[]>).map(
      ([name, settings]) => ({
        name,
        settings: settings.map((setting) => ({ ...setting })),
      }),
    );
    openRows.value = entries.value.map(rowKey);
  },
  // A path that cannot exist — `config.init.name.deeper`, where `name` holds a
  // string — comes back as a 400 saying so, and nothing was written.
  build: () =>
    Object.fromEntries(
      entries.value
        .filter((entry) => entry.name)
        .map((entry) => [
          entry.name,
          entry.settings.filter((setting) => setting.path.trim()),
        ]),
    ),
  async after() {
    // The explorer's `overrides` branch, and ScenariosEditor's "declared
    // nowhere" check, both read the component tree — a new override has to
    // reach it or the save reads as having failed.
    await componentTree.refresh(props.versionId);
  },
});

function addEntry() {
  entries.value.push({ name: "", settings: [] });
  openRows.value = [
    ...openRows.value,
    rowKey(entries.value[entries.value.length - 1]),
  ];
  onChange();
}

function removeEntry(entry: OverrideEntry) {
  const at = entries.value.indexOf(entry);
  if (at !== -1) entries.value.splice(at, 1);
  onChange();
}

function addSetting(entry: OverrideEntry) {
  entry.settings.push({ path: "", value: null });
  onChange();
}

function removeSetting(entry: OverrideEntry, index: number) {
  entry.settings.splice(index, 1);
  onChange();
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
              ? `No override called "${entryName}".`
              : "No overrides defined yet."
          }}
        </StateMessage>

        <Accordion v-else v-model="openRows" type="multiple" class="px-2">
          <EntryAccordionRow
            v-for="entry in visibleEntries"
            :key="rowKey(entry)"
            :value="rowKey(entry)"
            :name="entry.name || '(unnamed)'"
            remove-label="Remove this override"
            testid="entry-row"
            @remove="removeEntry(entry)"
          >
            <template #meta>
              <span class="shrink-0 text-2xs text-text-faint">
                {{ entry.settings.length }}
                {{ entry.settings.length === 1 ? "setting" : "settings" }}
              </span>
            </template>

            <FieldRow label="name" width="short">
              <input
                v-model="entry.name"
                type="text"
                :class="FIELD"
                @input="onChange"
              />
            </FieldRow>

            <!-- The wide gutter, because these keys are paths: at the
                 standard 9rem, `config.solve.spores.number` and
                 `config.solve.spores.tracking_parameter` truncate to the
                 same string. -->
            <FieldRow
              v-for="(setting, index) in entry.settings"
              :key="index"
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
                  @click="removeSetting(entry, index)"
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
