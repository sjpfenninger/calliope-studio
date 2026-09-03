<script setup lang="ts">
/**
 * Scenarios: named, ordered combinations of overrides.
 *
 * Genuinely structured, and small — one row per scenario, with the overrides it
 * composes. Unlike an override, which can set anything a model can, a scenario
 * is a *list of names*, so it gets a real form.
 *
 * Two things this has to get right:
 *
 * - **Order matters.** Later overrides win, so the control is a sequence rather
 *   than a set: each chosen override can be moved up or down, and the order it
 *   is shown in is the order that gets written.
 * - **A name that resolves to nothing is flagged.** A typo currently fails at
 *   run time, with a message that does not say which scenario was at fault.
 */
import { computed, ref } from "vue";
import LockedBanner from "@/components/app/LockedBanner.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import { rowKey } from "@/lib/entries";
import { ChevronDown, ChevronUp, Plus, TriangleAlert, Trash2, X } from "@lucide/vue";

import { useSectionEditor } from "@/composables/useSectionEditor";
import EditorToolbar from "./EditorToolbar.vue";
import { MultiSelect } from "@/components/ui/multi-select";
import FieldRow from "@/components/app/FieldRow.vue";
import InfoTip from "@/components/app/InfoTip.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import { FIELD, GHOST_BUTTON } from "@/lib/formClasses";
import { useComponentTreeStore } from "@/stores/componentTree";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabId: string;
  entryName?: string | null;
}>();

const componentTree = useComponentTreeStore();

interface ScenarioEntry {
  name: string;
  overrides: string[];
}

const entries = ref<ScenarioEntry[]>([]);

const visibleEntries = computed(() =>
  props.entryName
    ? entries.value.filter((entry) => entry.name === props.entryName)
    : entries.value,
);

/**
 * Every override name in the model, not just this file's.
 *
 * A scenario may compose overrides defined anywhere in the import graph, which
 * is exactly what the component tree already knows.
 */
const knownOverrides = computed(() =>
  (componentTree.tree?.overrides?.entries ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry.name,
  ),
);

function unresolved(entry: ScenarioEntry): string[] {
  // Only once the tree has actually loaded; an empty list would otherwise flag
  // every override in the model as missing.
  if (!knownOverrides.value.length) return [];
  return entry.overrides.filter((name) => !knownOverrides.value.includes(name));
}

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
  section: "scenarios",
  label: "scenarios",
  apply(data) {
    entries.value = Object.entries(data).map(([name, value]) => ({
      name,
      // Calliope accepts a bare string as well as a list.
      overrides: Array.isArray(value) ? value.map(String) : value ? [String(value)] : [],
    }));
  },
  build: () =>
    Object.fromEntries(
      entries.value.filter((entry) => entry.name).map((entry) => [entry.name, entry.overrides]),
    ),
  async after() {
    // The explorer's `scenarios` branch shows this section, and `unresolved`
    // above reads the tree — both answer from the pre-save model until it is
    // refreshed.
    await componentTree.refresh(props.versionId);
  },
});

function addEntry() {
  entries.value.push({ name: "", overrides: [] });
  onChange();
}

function removeEntry(entry: ScenarioEntry) {
  const at = entries.value.indexOf(entry);
  if (at !== -1) entries.value.splice(at, 1);
  onChange();
}

/** Moves one override within a scenario. Later overrides win, so this matters. */
function move(entry: ScenarioEntry, index: number, by: number) {
  const to = index + by;
  if (to < 0 || to >= entry.overrides.length) return;
  const [moved] = entry.overrides.splice(index, 1);
  entry.overrides.splice(to, 0, moved);
  onChange();
}

function drop(entry: ScenarioEntry, index: number) {
  entry.overrides.splice(index, 1);
  onChange();
}

/**
 * The multi-select is a set; the scenario is a sequence.
 *
 * Newly chosen names go on the end, and the existing order is kept, so picking
 * one out of the middle of the list does not silently reshuffle precedence.
 */
function setOverrides(entry: ScenarioEntry, chosen: string[]) {
  const kept = entry.overrides.filter((name) => chosen.includes(name));
  entry.overrides = [...kept, ...chosen.filter((name) => !kept.includes(name))];
  onChange();
}

const onChange = markDirty;
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="scenarios-editor">
    <StateMessage v-if="isLoading" variant="block" loading>
      Loading scenarios…
    </StateMessage>
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
          data-testid="add-scenario"
          :class="GHOST_BUTTON"
          :disabled="locked"
          @click="addEntry"
        >
          <Plus class="size-3.5" />
          Add scenario
        </button>
      </EditorToolbar>
      <LockedBanner v-if="lockOwner" :owner="lockOwner" :file="filePath" />

      <fieldset :disabled="locked" class="min-h-0 flex-1 overflow-auto p-2">
        <StateMessage v-if="!visibleEntries.length" variant="block">
          {{
            entryName
              ? `No scenario called "${entryName}".`
              : "No scenarios defined yet."
          }}
        </StateMessage>

        <section
          v-for="entry in visibleEntries"
          :key="rowKey(entry)"
          class="mb-2 flex flex-col gap-1.5 rounded-sm border border-border p-2"
          data-testid="scenario"
        >
          <FieldRow label="name" width="short">
            <input
              v-model="entry.name"
              type="text"
              :class="FIELD"
              @input="onChange"
            />
            <template #action>
              <MultiSelect
                :model-value="entry.overrides"
                :options="knownOverrides"
                placeholder="Add overrides…"
                class="w-56"
                @update:model-value="(value) => setOverrides(entry, value)"
              />
              <TooltipButton
                label="Remove this scenario"
                :icon="Trash2"
                tone="danger"
                @click="removeEntry(entry)"
              />
            </template>
          </FieldRow>

          <!-- In order, because later overrides win. -->
          <ol class="flex flex-col">
            <li
              v-for="(name, index) in entry.overrides"
              :key="name"
              class="flex h-6 items-center gap-1 rounded-xs px-1 text-sm hover:bg-hover"
            >
              <span class="w-4 shrink-0 text-right text-2xs tabular-nums text-text-faint">
                {{ index + 1 }}
              </span>
              <span class="min-w-0 flex-1 truncate">{{ name }}</span>

              <InfoTip
                v-if="unresolved(entry).includes(name)"
                label="No override of this name is defined anywhere in the model"
              >
                <span
                  class="inline-flex shrink-0 items-center gap-1 rounded-xs bg-warning-soft px-1 text-2xs text-warning-text"
                >
                  <TriangleAlert class="size-3" />
                  unknown
                </span>
              </InfoTip>

              <TooltipButton
                label="Apply earlier"
                :icon="ChevronUp"
                size="xs"
                :disabled="index === 0"
                @click="move(entry, index, -1)"
              />
              <TooltipButton
                label="Apply later"
                :icon="ChevronDown"
                size="xs"
                :disabled="index === entry.overrides.length - 1"
                @click="move(entry, index, 1)"
              />
              <TooltipButton
                label="Remove"
                :icon="X"
                tone="danger"
                size="xs"
                @click="drop(entry, index)"
              />
            </li>
          </ol>

          <p v-if="!entry.overrides.length" class="px-1 text-2xs text-text-faint">
            This scenario composes no overrides.
          </p>
        </section>
      </fieldset>
    </template>
  </div>
</template>
