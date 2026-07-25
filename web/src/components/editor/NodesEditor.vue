<script setup lang="ts">
/**
 * NodesEditor — accordion-per-node editor for the `nodes:` YAML section.
 *
 * Supports three modes via props:
 *   - Section tab (entryName=null): shows all nodes in the file
 *   - Entry tab (entryName="region1"): shows only the named node
 *   - File structured view (tabKey=filePath, entryName=null): shows all nodes
 *
 * Saves always write the full section back to the file.
 */
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import Accordion from "primevue/accordion";
import AccordionPanel from "primevue/accordionpanel";
import AccordionHeader from "primevue/accordionheader";
import AccordionContent from "primevue/accordioncontent";
import InputText from "primevue/inputtext";
import InputNumber from "primevue/inputnumber";
import ToggleSwitch from "primevue/toggleswitch";
import Button from "primevue/button";
import client from "../../api/client";
import { useEditorStore } from "../../stores/editor";
import { useSectionDataStore } from "../../stores/sectionData";
import { useComponentTreeStore } from "../../stores/componentTree";
import ScalarOrDataVar from "./ScalarOrDataVar.vue";
import NodesMapView from "./NodesMapView.vue";

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
// Local view mode — not persisted in the tab store, only relevant for nodes
const viewMode = ref<"structured" | "map">("structured");

interface TechOverride {
  techName: string;
  params: Array<{ key: string; value: any }>;
}

interface NodeEntry {
  name: string;
  template: string | null;
  active: boolean;
  latitude: number | null;
  longitude: number | null;
  extraParams: Array<{ key: string; value: any }>;
  techs: TechOverride[];
}

const entries = ref<NodeEntry[]>([]);
const templatesData = ref<Record<string, Record<string, any>>>({});

interface DtParam { value: any; time_varying: boolean; source: string }
// Map from node name → param name → data-table info
const dataTableParams = ref<Record<string, Record<string, DtParam>>>({});

// When entryName is set (entry tab), show only the matching entry
const visibleEntries = computed(() =>
  props.entryName
    ? entries.value.filter((e) => e.name === props.entryName)
    : entries.value
);

function rawTechsToOverrides(raw: Record<string, any> | null): TechOverride[] {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw).map(([techName, params]) => ({
    techName,
    params: Object.entries(params ?? {}).map(([k, v]) => ({ key: k, value: v })),
  }));
}

function rawToEntry(name: string, raw: Record<string, any> | null): NodeEntry {
  const d = raw ?? {};
  const extra: Array<{ key: string; value: any }> = [];
  const KNOWN = new Set(["active", "latitude", "longitude", "techs", "template"]);
  for (const [k, v] of Object.entries(d)) {
    if (!KNOWN.has(k)) extra.push({ key: k, value: v });
  }
  return {
    name,
    template: d.template ?? null,
    active: d.active !== false,
    latitude: d.latitude ?? null,
    longitude: d.longitude ?? null,
    extraParams: extra,
    techs: rawTechsToOverrides(d.techs ?? null),
  };
}

function entryToRaw(e: NodeEntry): Record<string, any> {
  const result: Record<string, any> = {};
  if (e.active === false) result.active = false;
  if (e.template) result.template = e.template;
  if (e.latitude !== null) result.latitude = e.latitude;
  if (e.longitude !== null) result.longitude = e.longitude;
  for (const { key, value } of e.extraParams) {
    if (!key) continue;
    if (value !== null && value !== undefined && value !== "") result[key] = value;
  }
  if (e.techs.length > 0) {
    const techsObj: Record<string, any> = {};
    for (const t of e.techs) {
      if (!t.techName) continue;
      const paramObj: Record<string, any> = {};
      for (const { key, value } of t.params) {
        if (!key) continue;
        if (value !== null && value !== undefined && value !== "") paramObj[key] = value;
      }
      techsObj[t.techName] = Object.keys(paramObj).length ? paramObj : null;
    }
    if (Object.keys(techsObj).length) result.techs = techsObj;
  }
  return result;
}

async function load() {
  isLoading.value = true;
  error.value = null;
  try {
    const cached = sectionDataStore.get(props.versionId, props.filePath, "nodes");
    if (cached !== null) {
      entries.value = Object.entries(cached).map(([name, raw]) =>
        rawToEntry(name, raw as Record<string, any> | null)
      );
    } else {
      const res = await client.get<{ section: string; data: any }>(
        `/api/versions/${props.versionId}/yaml-section/${props.filePath}?section=nodes`
      );
      const d = res.data.data ?? {};
      sectionDataStore.set(props.versionId, props.filePath, "nodes", d);
      entries.value = Object.entries(d).map(([name, raw]) =>
        rawToEntry(name, raw as Record<string, any> | null)
      );
    }
    await loadTemplatesSection();
    await loadDataTableParams();
  } catch (e: any) {
    error.value = e?.response?.data?.detail ?? "Failed to load nodes section.";
  } finally {
    isLoading.value = false;
  }
}

async function loadTemplatesSection() {
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
      `/api/versions/${props.versionId}/data-table-params/?kind=node`
    );
    dataTableParams.value = res.data.params ?? {};
  } catch {
    dataTableParams.value = {};
  }
}

function isNodeFieldOverridden(entry: NodeEntry, key: string): boolean {
  if (key === "template") return false;
  if (key === "active") return entry.active === false;
  if (key === "latitude") return entry.latitude !== null;
  if (key === "longitude") return entry.longitude !== null;
  if (key === "techs") return entry.techs.length > 0;
  return entry.extraParams.some((p) => p.key === key);
}

function formatTemplateValue(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function buildPayload(): Record<string, any> {
  const result: Record<string, any> = {};
  for (const e of entries.value) {
    if (!e.name) continue;
    result[e.name] = entryToRaw(e);
  }
  return result;
}

async function save() {
  isSaving.value = true;
  try {
    const payload = buildPayload();
    await client.put(
      `/api/versions/${props.versionId}/yaml-section/${props.filePath}?section=nodes`,
      { data: payload }
    );
    sectionDataStore.set(props.versionId, props.filePath, "nodes", payload);
    editorStore.markClean(props.tabKey);
  } finally {
    isSaving.value = false;
  }
}

function onChange() {
  editorStore.markDirty(props.tabKey);
}

function addEntry() {
  entries.value.push({ name: "", template: null, active: true, latitude: null, longitude: null, extraParams: [], techs: [] });
  onChange();
}

function removeEntry(entry: NodeEntry) {
  const i = entries.value.indexOf(entry);
  if (i !== -1) entries.value.splice(i, 1);
  onChange();
}

function addExtraParam(entry: NodeEntry) {
  entry.extraParams.push({ key: "", value: null });
  onChange();
}

function removeExtraParam(entry: NodeEntry, j: number) {
  entry.extraParams.splice(j, 1);
  onChange();
}

function addTech(entry: NodeEntry) {
  entry.techs.push({ techName: "", params: [] });
  onChange();
}

function removeTech(entry: NodeEntry, ti: number) {
  entry.techs.splice(ti, 1);
  onChange();
}

function addTechParam(entry: NodeEntry, ti: number) {
  entry.techs[ti].params.push({ key: "", value: null });
  onChange();
}

function removeTechParam(entry: NodeEntry, ti: number, pi: number) {
  entry.techs[ti].params.splice(pi, 1);
  onChange();
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
  <div class="nodes-editor">
    <template v-if="isLoading">
      <div class="placeholder">Loading nodes...</div>
    </template>
    <template v-else-if="error">
      <div class="placeholder error">{{ error }}</div>
    </template>
    <template v-else>
      <div class="toolbar">
        <Button label="Save" icon="pi pi-save" size="small" :loading="isSaving" @click="save" />
        <Button
          v-if="!entryName"
          label="Add node"
          icon="pi pi-plus"
          size="small"
          severity="secondary"
          @click="addEntry"
        />
        <Button
          v-if="!entryName"
          :icon="viewMode === 'map' ? 'pi pi-list' : 'pi pi-map'"
          :label="viewMode === 'map' ? 'List' : 'Map'"
          size="small"
          severity="secondary"
          @click="viewMode = viewMode === 'map' ? 'structured' : 'map'"
        />
        <span class="hint">or Ctrl/Cmd+S</span>
      </div>

      <div :class="['entry-list', { 'entry-list--map': viewMode === 'map' }]">
        <!-- Map view -->
        <NodesMapView
          v-if="viewMode === 'map'"
          :versionId="versionId"
          :nodes="entries"
          class="map-fill"
        />

        <!-- Structured list -->
        <template v-else>
        <div v-if="visibleEntries.length === 0" class="placeholder">
          {{
            entryName
              ? `Node "${entryName}" not found.`
              : 'No nodes defined. Click "Add node" to create one.'
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
                <!-- Name -->
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

                <!-- active -->
                <div class="field inline-field">
                  <label>active</label>
                  <ToggleSwitch v-model="entry.active" @update:modelValue="onChange" />
                </div>

                <!-- Coordinates -->
                <div class="coord-row">
                  <div class="field coord-field">
                    <label>latitude</label>
                    <InputNumber
                      v-model="entry.latitude"
                      size="small"
                      :minFractionDigits="0"
                      :maxFractionDigits="6"
                      :min="-90"
                      :max="90"
                      @update:modelValue="onChange"
                    />
                  </div>
                  <div class="field coord-field">
                    <label>longitude</label>
                    <InputNumber
                      v-model="entry.longitude"
                      size="small"
                      :minFractionDigits="0"
                      :maxFractionDigits="6"
                      :min="-180"
                      :max="180"
                      @update:modelValue="onChange"
                    />
                  </div>
                </div>

                <!-- Extra params (additionalProperties) -->
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
                      @click="removeExtraParam(entry, j)"
                    />
                  </div>
                </div>
                <Button
                  label="Add parameter"
                  icon="pi pi-plus"
                  size="small"
                  text
                  severity="secondary"
                  @click="addExtraParam(entry)"
                />

                <!-- Techs sub-section -->
                <div class="sub-section">
                  <div class="sub-section-header">
                    <span class="sub-section-label">techs</span>
                    <Button icon="pi pi-plus" size="small" text severity="secondary" @click="addTech(entry)" />
                  </div>

                  <div v-for="(techOvr, ti) in entry.techs" :key="ti" class="tech-override">
                    <div class="tech-name-row">
                      <InputText
                        v-model="techOvr.techName"
                        size="small"
                        placeholder="tech name"
                        class="tech-name-input"
                        @input="onChange"
                      />
                      <Button icon="pi pi-times" size="small" text severity="danger" @click="removeTech(entry, ti)" />
                    </div>

                    <div v-if="techOvr.params.length > 0" class="tech-params">
                      <div v-for="(p, pi) in techOvr.params" :key="pi" class="param-row">
                        <InputText
                          v-model="p.key"
                          size="small"
                          class="param-key"
                          placeholder="parameter"
                          @input="onChange"
                        />
                        <ScalarOrDataVar
                          :modelValue="p.value"
                          @update:modelValue="p.value = $event; onChange()"
                        />
                        <Button
                          icon="pi pi-times"
                          size="small"
                          text
                          severity="danger"
                          @click="removeTechParam(entry, ti, pi)"
                        />
                      </div>
                    </div>
                    <Button
                      label="Add override"
                      icon="pi pi-plus"
                      size="small"
                      text
                      severity="secondary"
                      class="add-override-btn"
                      @click="addTechParam(entry, ti)"
                    />
                  </div>

                  <div v-if="entry.techs.length === 0" class="sub-placeholder">No techs assigned.</div>
                </div>

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
                        :class="{ 'is-overridden': isNodeFieldOverridden(entry, k) }"
                      >{{ formatTemplateValue(v) }}</span>
                      <span v-if="isNodeFieldOverridden(entry, k)" class="override-tag">overridden</span>
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
                      :class="{ 'is-overridden': isNodeFieldOverridden(entry, k) }"
                    >{{ v.time_varying ? 'time-varying' : v.value }}</span>
                    <span class="dt-source-tag">{{ v.source }}</span>
                    <span v-if="isNodeFieldOverridden(entry, k)" class="override-tag">overridden</span>
                  </div>
                </div>
              </div>
            </AccordionContent>
          </AccordionPanel>
        </Accordion>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.nodes-editor {
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

.placeholder.error { color: #ef4444; }

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

.entry-list--map {
  overflow: hidden;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.map-fill {
  flex: 1;
  min-height: 0;
}

.entry-title {
  font-family: monospace;
  font-size: 0.875rem;
  flex: 1;
}

.delete-btn { margin-left: auto; }

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

.coord-row {
  display: flex;
  gap: 0.75rem;
}

.coord-field {
  flex: 1;
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

.sub-section {
  border: 1px solid var(--p-content-border-color, #e0e0e0);
  border-radius: 4px;
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.sub-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sub-section-label {
  font-size: 0.8rem;
  font-family: monospace;
  font-weight: 600;
  color: var(--p-text-muted-color, #666);
}

.tech-override {
  background: var(--p-surface-50, #f9fafb);
  border-radius: 4px;
  padding: 0.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.tech-name-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.tech-name-input {
  flex: 1;
}

.tech-params {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding-left: 0.5rem;
}

.add-override-btn {
  align-self: flex-start;
}

.sub-placeholder {
  font-size: 0.8rem;
  color: var(--p-text-muted-color, #888);
  text-align: center;
  padding: 0.25rem;
}

.w-full { width: 100%; }

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
