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
import Accordion from "primevue/accordion";
import AccordionPanel from "primevue/accordionpanel";
import AccordionHeader from "primevue/accordionheader";
import AccordionContent from "primevue/accordioncontent";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Button from "primevue/button";
import client from "../../api/client";
import { useTabsStore } from "../../stores/tabs";
import { useSectionDataStore } from "../../stores/sectionData";
import { useComponentTreeStore } from "../../stores/componentTree";
import ScalarOrDataVar from "./ScalarOrDataVar.vue";
import { isTransmission, mergeIntoSection, type RawTech } from "../../lib/techs";

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

/** Keys shown as their own fields rather than in the parameter list. */
const PROMOTED = new Set(["link_from", "link_to", "template", "base_tech", "active"]);

interface LinkEntry {
  name: string;
  linkFrom: string;
  linkTo: string;
  template: string | null;
  active: boolean;
  params: Array<{ key: string; value: any }>;
}

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

function rawToEntry(name: string, raw: RawTech): LinkEntry {
  const data = raw ?? {};
  return {
    name,
    linkFrom: data.link_from ?? "",
    linkTo: data.link_to ?? "",
    template: data.template ?? null,
    active: data.active !== false,
    params: Object.entries(data)
      .filter(([key]) => !PROMOTED.has(key))
      .map(([key, value]) => ({ key, value })),
  };
}

function entryToRaw(entry: LinkEntry): Record<string, any> {
  const result: Record<string, any> = {};
  if (entry.active === false) result.active = false;
  if (entry.template) result.template = entry.template;
  if (entry.linkFrom) result.link_from = entry.linkFrom;
  if (entry.linkTo) result.link_to = entry.linkTo;
  // Only written when not inherited, so a link using a template does not gain a
  // redundant base_tech it never had.
  if (!entry.template) result.base_tech = "transmission";
  for (const { key, value } of entry.params) {
    if (!key) continue;
    if (value !== null && value !== undefined && value !== "") result[key] = value;
  }
  return result;
}

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
      .map(([name, raw]) => rawToEntry(name, raw));
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
    if (entry.name) edited[entry.name] = entryToRaw(entry);
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
  <div class="links-editor">
    <div v-if="isLoading" class="placeholder">Loading transmission technologies…</div>
    <div v-else-if="error" class="placeholder error">{{ error }}</div>

    <template v-else>
      <div class="toolbar">
        <Button
          label="Save"
          icon="pi pi-save"
          size="small"
          :loading="isSaving"
          @click="save"
        />
        <Button
          v-if="!entryName"
          label="Add link"
          icon="pi pi-plus"
          size="small"
          severity="secondary"
          @click="addEntry"
        />
        <span class="hint">or Ctrl/Cmd+S</span>
      </div>

      <div class="entry-list">
        <div v-if="visibleEntries.length === 0" class="placeholder">
          {{
            entryName
              ? `Link "${entryName}" not found.`
              : 'No transmission technologies in this file. Click "Add link" to create one.'
          }}
        </div>

        <Accordion
          v-else
          :multiple="true"
          :value="visibleEntries.map((e) => e.name || String(entries.indexOf(e)))"
        >
          <AccordionPanel
            v-for="entry in visibleEntries"
            :key="entry.name || String(entries.indexOf(entry))"
            :value="entry.name || String(entries.indexOf(entry))"
          >
            <AccordionHeader>
              <span class="entry-title">
                {{ entry.name || "(unnamed)" }}
                <span v-if="entry.linkFrom || entry.linkTo" class="from-to">
                  {{ entry.linkFrom || "?" }} → {{ entry.linkTo || "?" }}
                </span>
              </span>
              <Button
                icon="pi pi-trash"
                size="small"
                severity="danger"
                text
                class="delete-btn"
                @click.stop="removeEntry(entry)"
              />
            </AccordionHeader>

            <AccordionContent>
              <div class="entry-form">
                <div class="field">
                  <label>name</label>
                  <InputText
                    v-model="entry.name"
                    size="small"
                    class="w-full"
                    @input="onChange"
                  />
                </div>

                <div class="from-to-row">
                  <div class="field ft-field">
                    <label>link_from</label>
                    <Select
                      v-model="entry.linkFrom"
                      :options="nodeNames"
                      editable
                      size="small"
                      class="w-full"
                      placeholder="node"
                      @change="onChange"
                    />
                  </div>
                  <div class="field ft-field">
                    <label>link_to</label>
                    <Select
                      v-model="entry.linkTo"
                      :options="nodeNames"
                      editable
                      size="small"
                      class="w-full"
                      placeholder="node"
                      @change="onChange"
                    />
                  </div>
                </div>

                <div v-if="entry.template" class="field">
                  <label>template</label>
                  <div class="template-note">
                    Inherits from <code>{{ entry.template }}</code>
                    <span v-if="inheritedFrom(entry, 'base_tech')">
                      (base_tech: {{ inheritedFrom(entry, "base_tech") }})
                    </span>
                  </div>
                </div>

                <div v-if="entry.params.length > 0" class="params">
                  <div
                    v-for="(param, index) in entry.params"
                    :key="index"
                    class="param-row"
                  >
                    <InputText
                      v-model="param.key"
                      size="small"
                      class="param-key"
                      placeholder="parameter"
                      @input="onChange"
                    />
                    <ScalarOrDataVar
                      :modelValue="param.value"
                      @update:modelValue="
                        param.value = $event;
                        onChange();
                      "
                    />
                    <Button
                      icon="pi pi-times"
                      size="small"
                      text
                      severity="danger"
                      @click="removeParam(entry, index)"
                    />
                  </div>
                </div>
                <Button
                  label="Add parameter"
                  icon="pi pi-plus"
                  size="small"
                  text
                  severity="secondary"
                  @click="addParam(entry)"
                />
              </div>
            </AccordionContent>
          </AccordionPanel>
        </Accordion>
      </div>
    </template>
  </div>
</template>

<style scoped>
.links-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.placeholder {
  padding: 2rem;
  text-align: center;
  color: var(--p-text-muted-color, #888);
  font-size: 0.875rem;
}
.placeholder.error {
  color: #ef4444;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 1rem;
  flex-shrink: 0;
  border-bottom: 1px solid var(--p-content-border-color, #e0e0e0);
}

.hint {
  font-size: 0.75rem;
  color: var(--p-text-muted-color, #888);
}

.entry-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem 1rem;
}

.entry-title {
  font-family: monospace;
  font-size: 0.875rem;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.from-to {
  font-size: 0.75rem;
  color: var(--p-text-muted-color, #888);
}

.delete-btn {
  margin-left: auto;
}

.entry-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.field label {
  font-size: 0.8rem;
  font-family: monospace;
  color: var(--p-text-muted-color, #666);
}

.from-to-row {
  display: flex;
  gap: 0.75rem;
}
.ft-field {
  flex: 1;
}

.template-note {
  font-size: 0.8rem;
  color: var(--p-text-muted-color, #888);
}

.params {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.param-row {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
}
.param-key {
  width: 9rem;
  flex-shrink: 0;
}

.w-full {
  width: 100%;
}
</style>
