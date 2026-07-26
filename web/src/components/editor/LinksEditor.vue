<script setup lang="ts">
/**
 * LinksEditor — the transmission technologies in a file's `techs:` section.
 *
 * Calliope 0.7 has no `links:` section: a link is an ordinary technology
 * carrying `link_from` and `link_to`. This editor shows only those, with the
 * endpoints promoted to their own fields, because that is what distinguishes a
 * link from any other technology.
 *
 * It shares the `techs:` section with TechsEditor, so it reloads the whole
 * section on save and writes back the entries it does not own untouched.
 */
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
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
import { useTabsStore } from "@/stores/tabs";
import { useSectionDataStore } from "@/stores/sectionData";
import { useComponentTreeStore } from "@/stores/componentTree";
import { isTransmission, mergeIntoSection, type RawTech } from "@/lib/techs";
import { linkToRaw, rawToLink, type LinkEntry } from "@/lib/entries";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabId: string;
  entryName?: string | null;
}>();

const tabsStore = useTabsStore();
const sectionDataStore = useSectionDataStore();
const componentTreeStore = useComponentTreeStore();

const isLoading = ref(true);
const isSaving = ref(false);
const error = ref<string | null>(null);

const entries = ref<LinkEntry[]>([]);
/** The section as loaded, so entries owned by TechsEditor survive a save. */
const originalSection = ref<Record<string, RawTech>>({});
const templatesData = ref<Record<string, Record<string, any>>>({});

const nodeNames = computed(() =>
  (componentTreeStore.tree?.nodes?.entries ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry.name,
  ),
);

const visibleEntries = computed(() =>
  props.entryName
    ? entries.value.filter((entry) => entry.name === props.entryName)
    : entries.value,
);

function owned(name: string): boolean {
  return isTransmission(originalSection.value[name] ?? null, templatesData.value);
}

async function fetchSection(file: string, section: string) {
  const cached = sectionDataStore.get(props.versionId, file, section);
  if (cached !== null) return cached;
  try {
    const response = await client.get<{ section: string; data: any }>(
      `/api/versions/${props.versionId}/yaml-section/${file}?section=${section}`,
    );
    const data = response.data.data ?? {};
    sectionDataStore.set(props.versionId, file, section, data);
    return data;
  } catch {
    return {};
  }
}

async function loadTemplates() {
  const files = new Set<string>([props.filePath]);
  for (const entry of componentTreeStore.tree?.templates?.entries ?? []) {
    if (typeof entry !== "string" && entry.file) files.add(entry.file);
  }
  const merged: Record<string, Record<string, any>> = {};
  for (const file of files) Object.assign(merged, await fetchSection(file, "templates"));
  templatesData.value = merged;
}

async function load() {
  isLoading.value = true;
  error.value = null;
  try {
    await loadTemplates();
    const section = (await fetchSection(props.filePath, "techs")) as Record<
      string,
      RawTech
    >;
    originalSection.value = section;
    entries.value = Object.entries(section)
      .filter(([, raw]) => isTransmission(raw, templatesData.value))
      .map(([name, raw]) => rawToLink(name, raw));
  } catch (caught: any) {
    error.value =
      caught?.response?.data?.detail ?? "Failed to load transmission technologies.";
  } finally {
    isLoading.value = false;
  }
}

function buildPayload(): Record<string, RawTech> {
  const edited: Record<string, RawTech> = {};
  for (const entry of entries.value) {
    if (entry.name) edited[entry.name] = linkToRaw(entry);
  }
  return mergeIntoSection(originalSection.value, edited, owned);
}

async function save() {
  isSaving.value = true;
  try {
    const payload = buildPayload();
    await client.put(
      `/api/versions/${props.versionId}/yaml-section/${props.filePath}?section=techs`,
      { data: payload },
    );
    sectionDataStore.set(props.versionId, props.filePath, "techs", payload);
    originalSection.value = payload;
    tabsStore.markClean(props.tabId);
    // Adding or removing a link changes the explorer and the map.
    await componentTreeStore.refresh(props.versionId);
  } finally {
    isSaving.value = false;
  }
}

function onChange() {
  tabsStore.markDirty(props.tabId);
}

function addEntry() {
  entries.value.push({
    name: "",
    linkFrom: "",
    linkTo: "",
    template: null,
    active: true,
    params: [],
  });
  onChange();
}

function removeEntry(entry: LinkEntry) {
  const index = entries.value.indexOf(entry);
  if (index !== -1) entries.value.splice(index, 1);
  onChange();
}

function addParam(entry: LinkEntry) {
  entry.params.push({ key: "", value: null });
  onChange();
}

function removeParam(entry: LinkEntry, index: number) {
  entry.params.splice(index, 1);
  onChange();
}

function inheritedFrom(entry: LinkEntry, key: string): any {
  if (!entry.template) return undefined;
  return templatesData.value[entry.template]?.[key];
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
  <div class="flex min-h-0 flex-1 flex-col">
    <p v-if="isLoading" class="p-6 text-center text-sm text-muted-foreground">
      Loading transmission technologies…
    </p>
    <p v-else-if="error" class="p-6 text-center text-sm text-danger-text">{{ error }}</p>

    <template v-else>
      <EditorToolbar :saving="isSaving" @save="save">
        <button v-if="!entryName" type="button" :class="GHOST_BUTTON" @click="addEntry">
          <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
          Add link
        </button>
      </EditorToolbar>

      <div class="min-h-0 flex-1 overflow-auto">
        <p
          v-if="!visibleEntries.length"
          class="p-6 text-center text-sm text-muted-foreground"
        >
          {{
            entryName
              ? `No link called "${entryName}".`
              : "No transmission technologies in this file."
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
                <span
                  v-if="entry.linkFrom || entry.linkTo"
                  class="shrink-0 text-2xs text-text-faint"
                >
                  {{ entry.linkFrom || "?" }} → {{ entry.linkTo || "?" }}
                </span>
              </AccordionTrigger>
              <button
                type="button"
                title="Remove this link"
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

                <!-- The endpoints, which are what make this a link. Free text
                     with suggestions rather than a closed list: a link may name
                     a node defined in a file this editor has not loaded. -->
                <div class="flex gap-2">
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <label :class="FIELD_LABEL">link_from</label>
                    <input
                      v-model="entry.linkFrom"
                      type="text"
                      list="link-node-names"
                      placeholder="node"
                      :class="FIELD"
                      @change="onChange"
                    />
                  </div>
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <label :class="FIELD_LABEL">link_to</label>
                    <input
                      v-model="entry.linkTo"
                      type="text"
                      list="link-node-names"
                      placeholder="node"
                      :class="FIELD"
                      @change="onChange"
                    />
                  </div>
                </div>

                <p v-if="entry.template" class="text-2xs text-text-faint">
                  Inherits from <code class="font-mono">{{ entry.template }}</code>
                  <span v-if="inheritedFrom(entry, 'base_tech')">
                    (base_tech: {{ inheritedFrom(entry, "base_tech") }})
                  </span>
                </p>

                <div v-if="entry.params.length" class="flex flex-col gap-1">
                  <div
                    v-for="(param, index) in entry.params"
                    :key="index"
                    class="flex items-start gap-1"
                  >
                    <input
                      v-model="param.key"
                      type="text"
                      placeholder="parameter"
                      :class="cn(FIELD, 'w-36 shrink-0')"
                      @input="onChange"
                    />
                    <ScalarOrDataVar
                      :model-value="param.value"
                      @update:model-value="
                        param.value = $event;
                        onChange();
                      "
                    />
                    <button
                      type="button"
                      title="Remove this parameter"
                      :class="DANGER_ICON_BUTTON"
                      @click="removeParam(entry, index)"
                    >
                      <X class="size-3.5" :stroke-width="2" />
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  :class="cn(GHOST_BUTTON, 'self-start')"
                  @click="addParam(entry)"
                >
                  <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
                  Add parameter
                </button>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        <datalist id="link-node-names">
          <option v-for="node in nodeNames" :key="node" :value="node" />
        </datalist>
      </div>
    </template>
  </div>
</template>
