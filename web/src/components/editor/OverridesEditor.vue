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
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { Plus, Trash2, X } from "lucide-vue-next";

import client from "@/api/client";
import EditorToolbar from "./EditorToolbar.vue";
import ScalarOrDataVar from "./ScalarOrDataVar.vue";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  DANGER_ICON_BUTTON,
  FIELD,
  FIELD_LABEL,
  GHOST_BUTTON,
} from "@/lib/formClasses";
import { ICON_STROKE_WIDTH } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useComponentTreeStore } from "@/stores/componentTree";
import { useTabsStore } from "@/stores/tabs";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabId: string;
  entryName?: string | null;
}>();

const tabsStore = useTabsStore();
const componentTree = useComponentTreeStore();

const isLoading = ref(true);
const isSaving = ref(false);
const error = ref<string | null>(null);

interface Setting {
  path: string;
  value: any;
}

interface OverrideEntry {
  name: string;
  settings: Setting[];
}

const entries = ref<OverrideEntry[]>([]);

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

async function load() {
  isLoading.value = true;
  error.value = null;
  try {
    const res = await client.get<{ overrides: Record<string, Setting[]> }>(
      `/api/versions/${props.versionId}/overrides/${props.filePath}`,
    );
    entries.value = Object.entries(res.data.overrides).map(([name, settings]) => ({
      name,
      settings: settings.map((setting) => ({ ...setting })),
    }));
  } catch (e: any) {
    error.value = e?.response?.data?.detail ?? "Failed to load overrides.";
  } finally {
    isLoading.value = false;
    await nextTick();
    tabsStore.markClean(props.tabId);
  }
}

async function save() {
  isSaving.value = true;
  error.value = null;
  try {
    await client.put(`/api/versions/${props.versionId}/overrides/${props.filePath}`, {
      overrides: Object.fromEntries(
        entries.value
          .filter((entry) => entry.name)
          .map((entry) => [
            entry.name,
            entry.settings.filter((setting) => setting.path.trim()),
          ]),
      ),
    });
    tabsStore.markClean(props.tabId);
  } catch (e: any) {
    // A path that cannot exist — `config.init.name.deeper`, where `name` holds a
    // string — comes back as a 400 saying so, and nothing was written.
    error.value = e?.response?.data?.detail ?? "Failed to save overrides.";
  } finally {
    isSaving.value = false;
  }
}

function addEntry() {
  entries.value.push({ name: "", settings: [] });
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

function onChange() {
  tabsStore.markDirty(props.tabId);
}

function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
    event.preventDefault();
    save();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  load();
});

onUnmounted(() => window.removeEventListener("keydown", onKeydown));

watch(() => props.filePath, load);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="overrides-editor">
    <p v-if="isLoading" class="p-6 text-center text-sm text-muted-foreground">
      Loading overrides…
    </p>

    <template v-else>
      <EditorToolbar :saving="isSaving" @save="save">
        <button v-if="!entryName" type="button" :class="GHOST_BUTTON" @click="addEntry">
          <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
          Add override
        </button>
      </EditorToolbar>

      <p v-if="error" class="border-b border-border bg-danger-soft p-2 text-sm text-danger-text">
        {{ error }}
      </p>

      <div class="min-h-0 flex-1 overflow-auto">
        <p
          v-if="!visibleEntries.length"
          class="p-6 text-center text-sm text-muted-foreground"
        >
          {{
            entryName
              ? `No override called "${entryName}".`
              : "No overrides defined yet."
          }}
        </p>

        <Accordion
          v-else
          type="multiple"
          :default-value="visibleEntries.map((e) => e.name || String(entries.indexOf(e)))"
          class="px-2"
        >
          <AccordionItem
            v-for="entry in visibleEntries"
            :key="entry.name || String(entries.indexOf(entry))"
            :value="entry.name || String(entries.indexOf(entry))"
          >
            <div class="flex items-center gap-1.5">
              <AccordionTrigger
                class="min-w-0 flex-1 items-center gap-2 py-1.5 font-mono text-sm hover:no-underline"
              >
                <span class="truncate">{{ entry.name || "(unnamed)" }}</span>
                <span class="shrink-0 text-2xs text-text-faint">
                  {{ entry.settings.length }}
                  {{ entry.settings.length === 1 ? "setting" : "settings" }}
                </span>
              </AccordionTrigger>
              <button
                type="button"
                title="Remove this override"
                :class="DANGER_ICON_BUTTON"
                @click.stop="removeEntry(entry)"
              >
                <Trash2 class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
              </button>
            </div>

            <AccordionContent>
              <div class="flex flex-col gap-2 pb-2">
                <div class="flex flex-col gap-1">
                  <label :class="FIELD_LABEL">name</label>
                  <input
                    v-model="entry.name"
                    type="text"
                    :class="FIELD"
                    @input="onChange"
                  />
                </div>

                <div
                  v-for="(setting, index) in entry.settings"
                  :key="index"
                  class="flex items-start gap-1"
                  data-testid="override-setting"
                >
                  <input
                    v-model="setting.path"
                    type="text"
                    list="override-paths"
                    placeholder="config.init.name"
                    :class="cn(FIELD, 'w-64 shrink-0 font-mono')"
                    @input="onChange"
                  />
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
                  <button
                    type="button"
                    title="Remove this setting"
                    :class="DANGER_ICON_BUTTON"
                    @click="removeSetting(entry, index)"
                  >
                    <X class="size-3.5" :stroke-width="2" />
                  </button>
                </div>

                <button
                  type="button"
                  :class="cn(GHOST_BUTTON, 'self-start')"
                  @click="addSetting(entry)"
                >
                  <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
                  Add setting
                </button>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        <datalist id="override-paths">
          <option v-for="path in suggestions" :key="path" :value="path" />
        </datalist>
      </div>
    </template>
  </div>
</template>
