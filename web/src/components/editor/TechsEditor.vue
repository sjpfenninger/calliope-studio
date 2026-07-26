<script setup lang="ts">
/**
 * TechsEditor — accordion-per-tech editor for the `techs:` YAML section.
 *
 * Supports three modes via props:
 *   - Section tab (entryName=null): shows all techs in the file
 *   - Entry tab (entryName="csp"): shows only the named tech
 *   - File structured view (tabKey=filePath, entryName=null): shows all techs
 *
 * Transmission technologies are excluded: they are edited by LinksEditor, which
 * promotes the two nodes they join. They still share this YAML section, so a
 * save writes them back untouched rather than dropping them.
 */
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import Accordion from "primevue/accordion";
import AccordionPanel from "primevue/accordionpanel";
import AccordionHeader from "primevue/accordionheader";
import AccordionContent from "primevue/accordioncontent";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import ToggleSwitch from "primevue/toggleswitch";
import Button from "primevue/button";
import client from "../../api/client";
import { useEditorStore } from "../../stores/editor";
import { useSectionDataStore } from "../../stores/sectionData";
import { useComponentTreeStore } from "../../stores/componentTree";
import ScalarOrDataVar from "./ScalarOrDataVar.vue";
import { isTransmission, mergeIntoSection, type RawTech } from "../../lib/techs";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabKey: string;
  entryName?: string | null;
}>();

const editorStore = useEditorStore();
const sectionDataStore = useSectionDataStore();
const componentTreeStore = useComponentTreeStore();
const isLoading = ref(true);
const isSaving = ref(false);
const error = ref<string | null>(null);

const BASE_TECH_OPTIONS = ["supply", "demand", "storage", "transmission", "conversion"];

interface TechEntry {
  name: string;
  template: string | null;
  base_tech: string | null;
  active: boolean;
  extraParams: Array<{ key: string; value: any }>;
}

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

function rawToEntry(name: string, raw: Record<string, any> | null): TechEntry {
  const data = raw ?? {};
  const extra: Array<{ key: string; value: any }> = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "base_tech" || k === "active" || k === "template") continue;
    extra.push({ key: k, value: v });
  }
  return {
    name,
    template: data.template ?? null,
    base_tech: data.base_tech ?? null,
    active: data.active !== false,
    extraParams: extra,
  };
}

function entryToRaw(e: TechEntry): Record<string, any> {
  const result: Record<string, any> = {};
  if (e.active === false) result.active = false;
  if (e.template) result.template = e.template;
  if (e.base_tech) result.base_tech = e.base_tech;
  for (const { key, value } of e.extraParams) {
    if (!key) continue;
    if (value !== null && value !== undefined && value !== "") {
      result[key] = value;
    }
  }
  return result;
}

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
      .map(([name, raw]) => rawToEntry(name, raw));

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
    if (e.name) edited[e.name] = entryToRaw(e);
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
    editorStore.markClean(props.tabKey);
  } finally {
    isSaving.value = false;
  }
}

function addEntry() {
  entries.value.push({ name: "", template: null, base_tech: null, active: true, extraParams: [] });
  editorStore.markDirty(props.tabKey);
}

function removeEntry(entry: TechEntry) {
  const i = entries.value.indexOf(entry);
  if (i !== -1) entries.value.splice(i, 1);
  editorStore.markDirty(props.tabKey);
}

function addParam(entry: TechEntry) {
  entry.extraParams.push({ key: "", value: null });
  editorStore.markDirty(props.tabKey);
}

function removeParam(entry: TechEntry, j: number) {
  entry.extraParams.splice(j, 1);
  editorStore.markDirty(props.tabKey);
}

function onChange() {
  editorStore.markDirty(props.tabKey);
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
  <div class="techs-editor">
    <template v-if="isLoading">
      <div class="placeholder">Loading techs...</div>
    </template>
    <template v-else-if="error">
      <div class="placeholder error">{{ error }}</div>
    </template>
    <template v-else>
      <div class="toolbar">
        <Button label="Save" icon="pi pi-save" size="small" :loading="isSaving" @click="save" />
        <Button
          v-if="!entryName"
          label="Add tech"
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
              ? `Tech "${entryName}" not found.`
              : 'No techs defined. Click "Add tech" to create one.'
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
              <span class="entry-title">{{ entry.name || "(unnamed)" }}</span>
              <span v-if="entry.base_tech" class="base-tech-badge">{{ entry.base_tech }}</span>
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
                <!-- Name (dict key) -->
                <div class="field">
                  <label>name</label>
                  <InputText v-model="entry.name" size="small" class="w-full" @input="onChange" />
                </div>

                <!-- template -->
                <div class="field">
                  <label>template</label>
                  <InputText
                    :modelValue="entry.template ?? ''"
                    size="small"
                    class="w-full"
                    placeholder="(none)"
                    @update:modelValue="entry.template = ($event as string) || null; onChange()"
                  />
                </div>

                <!-- base_tech -->
                <div class="field">
                  <label>base_tech</label>
                  <Select
                    v-model="entry.base_tech"
                    :options="BASE_TECH_OPTIONS"
                    size="small"
                    class="w-full"
                    showClear
                    @update:modelValue="onChange"
                  />
                </div>

                <!-- active -->
                <div class="field inline-field">
                  <label>active</label>
                  <ToggleSwitch v-model="entry.active" @update:modelValue="onChange" />
                </div>

                <!-- Extra parameters (additionalProperties) -->
                <div v-if="entry.extraParams.length > 0" class="extra-params">
                  <div v-for="(param, j) in entry.extraParams" :key="j" class="param-row">
                    <InputText
                      v-model="param.key"
                      size="small"
                      class="param-key"
                      placeholder="parameter"
                      @input="onChange"
                    />
                    <ScalarOrDataVar
                      :modelValue="param.value"
                      @update:modelValue="param.value = $event; onChange()"
                    />
                    <Button
                      icon="pi pi-times"
                      size="small"
                      text
                      severity="danger"
                      @click="removeParam(entry, j)"
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

                <!-- Template inherited fields -->
                <div v-if="entry.template" class="sub-section template-ref">
                  <div class="sub-section-header">
                    <span class="sub-section-label">From: {{ entry.template }}</span>
                  </div>
                  <template v-if="templatesData[entry.template]">
                    <div
                      v-for="[k, v] in Object.entries(templatesData[entry.template])"
                      :key="k"
                      class="template-field-row"
                    >
                      <span class="template-field-key">{{ k }}</span>
                      <span
                        class="template-field-value"
                        :class="{ 'is-overridden': isTechFieldOverridden(entry, k) }"
                      >{{ formatTemplateValue(v) }}</span>
                      <span v-if="isTechFieldOverridden(entry, k)" class="override-tag">overridden</span>
                    </div>
                  </template>
                  <div v-else class="sub-placeholder">Template definition not available.</div>
                </div>

                <!-- Data table values -->
                <div
                  v-if="dataTableParams[entry.name] && Object.keys(dataTableParams[entry.name]).length > 0"
                  class="sub-section data-table-ref"
                >
                  <div class="sub-section-header">
                    <span class="sub-section-label">From data tables</span>
                  </div>
                  <div
                    v-for="[k, v] in Object.entries(dataTableParams[entry.name])"
                    :key="k"
                    class="template-field-row"
                  >
                    <span class="template-field-key">{{ k }}</span>
                    <span
                      class="template-field-value"
                      :class="{ 'is-overridden': isTechFieldOverridden(entry, k) }"
                    >{{ v.time_varying ? 'time-varying' : v.value }}</span>
                    <span class="dt-source-tag">{{ v.source }}</span>
                    <span v-if="isTechFieldOverridden(entry, k)" class="override-tag">overridden</span>
                  </div>
                </div>
              </div>
            </AccordionContent>
          </AccordionPanel>
        </Accordion>
      </div>
    </template>
  </div>
</template>

<style scoped>
.techs-editor {
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
}

.base-tech-badge {
  font-size: 0.7rem;
  background: var(--p-primary-50, #eef2ff);
  color: var(--p-primary-color, #6366f1);
  border-radius: 4px;
  padding: 0.1rem 0.4rem;
  margin-right: 0.5rem;
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

.inline-field {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.extra-params {
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

.sub-section {
  border: 1px solid var(--p-content-border-color, #e0e0e0);
  border-radius: 4px;
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.sub-section-header { display: flex; align-items: center; justify-content: space-between; }
.sub-section-label { font-size: 0.8rem; font-family: monospace; font-weight: 600; color: var(--p-text-muted-color, #666); }
.sub-placeholder { font-size: 0.8rem; color: var(--p-text-muted-color, #888); text-align: center; padding: 0.25rem; }

.template-ref { background: var(--p-surface-50, #f9fafb); }

.template-field-row {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.8rem;
  padding: 0.1rem 0;
}

.template-field-key {
  font-family: monospace;
  color: var(--p-text-muted-color, #666);
  flex-shrink: 0;
  min-width: 8rem;
}

.template-field-value {
  font-family: monospace;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.template-field-value.is-overridden {
  color: var(--p-text-muted-color, #aaa);
  text-decoration: line-through;
}

.override-tag {
  font-size: 0.65rem;
  color: var(--p-primary-color, #6366f1);
  background: var(--p-primary-50, #eef2ff);
  border-radius: 3px;
  padding: 0.05rem 0.3rem;
  flex-shrink: 0;
}

.data-table-ref { background: var(--p-surface-50, #f9fafb); }

.dt-source-tag {
  font-size: 0.65rem;
  color: var(--p-text-muted-color, #888);
  font-family: monospace;
  flex-shrink: 0;
}
</style>
