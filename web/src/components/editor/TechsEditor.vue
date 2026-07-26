<script setup lang="ts">
/**
 * TechsEditor — accordion-per-tech editor for the `techs:` YAML section.
 *
 * Supports three modes via props:
 *   - Section tab (entryName=null): shows all techs in the file
 *   - Entry tab (entryName="csp"): shows only the named tech
 *   - File structured view (tabId=filePath, entryName=null): shows all techs
 *
 * Transmission technologies are excluded: they are edited by LinksEditor, which
 * promotes the two nodes they join. They still share this YAML section, so a
 * save writes them back untouched rather than dropping them.
 */
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { Plus, Trash2, X } from "lucide-vue-next";

import client from "@/api/client";
import EditorToolbar from "./EditorToolbar.vue";
import InheritedFields from "./InheritedFields.vue";
import ScalarOrDataVar from "./ScalarOrDataVar.vue";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Switch } from "@/components/ui/switch";
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
import { rawToTech, techToRaw, type TechEntry } from "@/lib/entries";

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

const BASE_TECH_OPTIONS = ["supply", "demand", "storage", "transmission", "conversion"];

const entries = ref<TechEntry[]>([]);
// The section as loaded, so the transmission entries LinksEditor owns survive a
// save from here.
const originalSection = ref<Record<string, RawTech>>({});
// Map from template name → its raw fields (merged from all files that define templates)
const templatesData = ref<Record<string, Record<string, any>>>({});

interface DtParam { value: any; time_varying: boolean; source: string }
// Map from tech name → param name → data-table info
const dataTableParams = ref<Record<string, Record<string, DtParam>>>({});

// When entryName is set (entry tab), show only the matching entry
const visibleEntries = computed(() =>
  props.entryName
    ? entries.value.filter((e) => e.name === props.entryName)
    : entries.value
);

async function load() {
  isLoading.value = true;
  error.value = null;
  try {
    // Templates first: whether a technology is a transmission link usually
    // comes from its template, so nothing can be classified without them.
    await loadTemplatesSection();

    const cached = sectionDataStore.get(props.versionId, props.filePath, "techs");
    let section: Record<string, RawTech>;
    if (cached !== null) {
      section = cached as Record<string, RawTech>;
    } else {
      const res = await client.get<{ section: string; data: any }>(
        `/api/versions/${props.versionId}/yaml-section/${props.filePath}?section=techs`
      );
      section = (res.data.data ?? {}) as Record<string, RawTech>;
      sectionDataStore.set(props.versionId, props.filePath, "techs", section);
    }

    originalSection.value = section;
    entries.value = Object.entries(originalSection.value)
      .filter(([, raw]) => !isTransmission(raw, templatesData.value))
      .map(([name, raw]) => rawToTech(name, raw));

    await loadDataTableParams();
  } catch (e: any) {
    error.value = e?.response?.data?.detail ?? "Failed to load techs section.";
  } finally {
    isLoading.value = false;
  }
}

async function loadTemplatesSection() {
  // Gather all files that are known to contain templates (from component tree)
  const templateTree = componentTreeStore.tree?.templates?.entries ?? [];
  const files = new Set<string>([props.filePath]);
  for (const t of templateTree) {
    if (typeof t !== "string" && t.file) files.add(t.file);
  }
  const result: Record<string, Record<string, any>> = {};
  for (const file of files) {
    const cached = sectionDataStore.get(props.versionId, file, "templates");
    if (cached !== null) {
      Object.assign(result, cached);
      continue;
    }
    try {
      const res = await client.get<{ section: string; data: any }>(
        `/api/versions/${props.versionId}/yaml-section/${file}?section=templates`
      );
      const d = res.data.data ?? {};
      sectionDataStore.set(props.versionId, file, "templates", d);
      Object.assign(result, d);
    } catch {
      // templates section absent in this file — skip
    }
  }
  templatesData.value = result;
}

async function loadDataTableParams() {
  try {
    const res = await client.get(
      `/api/versions/${props.versionId}/data-table-params/?kind=tech`
    );
    dataTableParams.value = res.data.params ?? {};
  } catch {
    dataTableParams.value = {};
  }
}

function isTechFieldOverridden(entry: TechEntry, key: string): boolean {
  if (key === "template") return false;
  if (key === "base_tech") return entry.base_tech !== null;
  if (key === "active") return entry.active === false;
  return entry.extraParams.some((p) => p.key === key);
}

function formatTemplateValue(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function ownedHere(name: string): boolean {
  return !isTransmission(originalSection.value[name] ?? null, templatesData.value);
}

function buildPayload(): Record<string, RawTech> {
  const edited: Record<string, RawTech> = {};
  for (const e of entries.value) {
    if (e.name) edited[e.name] = techToRaw(e);
  }
  // Transmission entries belong to LinksEditor; writing only what is shown here
  // would delete every link in the file.
  return mergeIntoSection(originalSection.value, edited, ownedHere);
}

async function save() {
  isSaving.value = true;
  try {
    const payload = buildPayload();
    await client.put(
      `/api/versions/${props.versionId}/yaml-section/${props.filePath}?section=techs`,
      { data: payload }
    );
    sectionDataStore.set(props.versionId, props.filePath, "techs", payload);
    originalSection.value = payload;
    tabsStore.markClean(props.tabId);
  } finally {
    isSaving.value = false;
  }
}

function addEntry() {
  entries.value.push({ name: "", template: null, base_tech: null, active: true, extraParams: [] });
  tabsStore.markDirty(props.tabId);
}

function removeEntry(entry: TechEntry) {
  const i = entries.value.indexOf(entry);
  if (i !== -1) entries.value.splice(i, 1);
  tabsStore.markDirty(props.tabId);
}

function addParam(entry: TechEntry) {
  entry.extraParams.push({ key: "", value: null });
  tabsStore.markDirty(props.tabId);
}

function removeParam(entry: TechEntry, j: number) {
  entry.extraParams.splice(j, 1);
  tabsStore.markDirty(props.tabId);
}

function onChange() {
  tabsStore.markDirty(props.tabId);
}

/** Template fields, as displayable strings. */
function templateFields(name: string | null): Record<string, string> {
  const raw = (name && templatesData.value[name]) || {};
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, formatTemplateValue(value)]),
  );
}

/** Data-table values for one technology, and which table each came from. */
function dataTableFields(name: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dataTableParams.value[name] ?? {}).map(([key, param]) => [
      key,
      param.time_varying ? "time-varying" : String(param.value),
    ]),
  );
}

function dataTableSources(name: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dataTableParams.value[name] ?? {}).map(([key, param]) => [
      key,
      param.source,
    ]),
  );
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    save();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  load();
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
});

watch(() => props.filePath, load);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <p v-if="isLoading" class="p-6 text-center text-sm text-muted-foreground">
      Loading techs…
    </p>
    <p v-else-if="error" class="p-6 text-center text-sm text-danger-text">{{ error }}</p>

    <template v-else>
      <EditorToolbar :saving="isSaving" @save="save">
        <button v-if="!entryName" type="button" :class="GHOST_BUTTON" @click="addEntry">
          <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
          Add tech
        </button>
      </EditorToolbar>

      <div class="min-h-0 flex-1 overflow-auto">
        <p
          v-if="!visibleEntries.length"
          class="p-6 text-center text-sm text-muted-foreground"
        >
          {{ entryName ? `No tech called "${entryName}".` : "No techs defined yet." }}
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
                class="min-w-0 flex-1 items-center py-1.5 font-mono text-sm hover:no-underline"
              >
                {{ entry.name || "(unnamed)" }}
              </AccordionTrigger>
              <span
                v-if="entry.base_tech"
                class="shrink-0 rounded-xs bg-accent-soft px-1 text-2xs text-accent-text"
              >
                {{ entry.base_tech }}
              </span>
              <button
                type="button"
                title="Remove this tech"
                :class="DANGER_ICON_BUTTON"
                @click.stop="removeEntry(entry)"
              >
                <Trash2 class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
              </button>
            </div>

            <AccordionContent>
              <div class="flex flex-col gap-2 pb-2">
                <!-- name is the mapping key, not a parameter. -->
                <div class="flex flex-col gap-1">
                  <label :class="FIELD_LABEL">name</label>
                  <input
                    v-model="entry.name"
                    type="text"
                    :class="FIELD"
                    @input="onChange"
                  />
                </div>

                <div class="flex flex-col gap-1">
                  <label :class="FIELD_LABEL">template</label>
                  <input
                    :value="entry.template ?? ''"
                    type="text"
                    placeholder="(none)"
                    :class="FIELD"
                    @change="
                      entry.template =
                        ($event.target as HTMLInputElement).value || null;
                      onChange();
                    "
                  />
                </div>

                <div class="flex flex-col gap-1">
                  <label :class="FIELD_LABEL">base_tech</label>
                  <select
                    :value="entry.base_tech ?? ''"
                    :class="FIELD"
                    @change="
                      entry.base_tech =
                        ($event.target as HTMLSelectElement).value || null;
                      onChange();
                    "
                  >
                    <!-- Blank first: base_tech usually comes from the template,
                         and setting it here is an override, not a requirement. -->
                    <option value="">—</option>
                    <option v-for="option in BASE_TECH_OPTIONS" :key="option" :value="option">
                      {{ option }}
                    </option>
                  </select>
                </div>

                <div class="flex items-center justify-between gap-2">
                  <label :class="FIELD_LABEL">active</label>
                  <Switch v-model="entry.active" @update:model-value="onChange" />
                </div>

                <div v-if="entry.extraParams.length" class="flex flex-col gap-1">
                  <div
                    v-for="(param, j) in entry.extraParams"
                    :key="j"
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
                      @click="removeParam(entry, j)"
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

                <InheritedFields
                  v-if="entry.template"
                  :label="`From: ${entry.template}`"
                  :fields="templateFields(entry.template)"
                  :is-overridden="(key) => isTechFieldOverridden(entry, key)"
                  empty-text="Template definition not available."
                />

                <InheritedFields
                  v-if="Object.keys(dataTableParams[entry.name] ?? {}).length"
                  label="From data tables"
                  :fields="dataTableFields(entry.name)"
                  :sources="dataTableSources(entry.name)"
                  :is-overridden="(key) => isTechFieldOverridden(entry, key)"
                />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </template>
  </div>
</template>
