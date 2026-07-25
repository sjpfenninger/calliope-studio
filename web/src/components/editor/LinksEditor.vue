<script setup lang="ts">
/**
 * LinksEditor — accordion-per-link editor for the `links:` YAML section.
 *
 * Supports three modes via props:
 *   - Section tab (entryName=null): shows all links in the file
 *   - Entry tab (entryName="region1,region2"): shows only the named link
 *   - File structured view (tabKey=filePath, entryName=null): shows all links
 *
 * Saves always write the full section back to the file.
 */
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import Accordion from "primevue/accordion";
import AccordionPanel from "primevue/accordionpanel";
import AccordionHeader from "primevue/accordionheader";
import AccordionContent from "primevue/accordioncontent";
import InputText from "primevue/inputtext";
import Button from "primevue/button";
import client from "../../api/client";
import { useEditorStore } from "../../stores/editor";
import { useSectionDataStore } from "../../stores/sectionData";
import ScalarOrDataVar from "./ScalarOrDataVar.vue";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabKey: string;
  entryName?: string | null;
}>();

const editorStore = useEditorStore();
const sectionDataStore = useSectionDataStore();
const isLoading = ref(true);
const isSaving = ref(false);
const error = ref<string | null>(null);

interface LinkTech {
  techName: string;
  params: Array<{ key: string; value: any }>;
}

interface LinkEntry {
  name: string;
  from: string;
  to: string;
  techs: LinkTech[];
  extraParams: Array<{ key: string; value: any }>;
}

const entries = ref<LinkEntry[]>([]);

// When entryName is set (entry tab), show only the matching entry
const visibleEntries = computed(() =>
  props.entryName
    ? entries.value.filter((e) => e.name === props.entryName)
    : entries.value
);

function rawToEntry(name: string, raw: Record<string, any> | null): LinkEntry {
  const d = raw ?? {};
  const KNOWN = new Set(["from", "to", "techs"]);
  const extra: Array<{ key: string; value: any }> = [];
  for (const [k, v] of Object.entries(d)) {
    if (!KNOWN.has(k)) extra.push({ key: k, value: v });
  }
  const techsRaw = d.techs ?? {};
  const techs: LinkTech[] = Object.entries(techsRaw).map(([techName, params]) => ({
    techName,
    params: Object.entries(params ?? {}).map(([k, v]) => ({ key: k, value: v })),
  }));
  return {
    name,
    from: d.from ?? "",
    to: d.to ?? "",
    techs,
    extraParams: extra,
  };
}

function entryToRaw(e: LinkEntry): Record<string, any> {
  const result: Record<string, any> = {};
  if (e.from) result.from = e.from;
  if (e.to) result.to = e.to;
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
    const cached = sectionDataStore.get(props.versionId, props.filePath, "links");
    if (cached !== null) {
      entries.value = Object.entries(cached).map(([name, raw]) =>
        rawToEntry(name, raw as Record<string, any> | null)
      );
      return;
    }
    const res = await client.get<{ section: string; data: any }>(
      `/api/versions/${props.versionId}/yaml-section/${props.filePath}?section=links`
    );
    const d = res.data.data ?? {};
    sectionDataStore.set(props.versionId, props.filePath, "links", d);
    entries.value = Object.entries(d).map(([name, raw]) =>
      rawToEntry(name, raw as Record<string, any> | null)
    );
  } catch (e: any) {
    error.value = e?.response?.data?.detail ?? "Failed to load links section.";
  } finally {
    isLoading.value = false;
  }
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
      `/api/versions/${props.versionId}/yaml-section/${props.filePath}?section=links`,
      { data: payload }
    );
    sectionDataStore.set(props.versionId, props.filePath, "links", payload);
    editorStore.markClean(props.tabKey);
  } finally {
    isSaving.value = false;
  }
}

function onChange() {
  editorStore.markDirty(props.tabKey);
}

function addEntry() {
  entries.value.push({ name: "", from: "", to: "", techs: [], extraParams: [] });
  onChange();
}

function removeEntry(entry: LinkEntry) {
  const i = entries.value.indexOf(entry);
  if (i !== -1) entries.value.splice(i, 1);
  onChange();
}

function addTech(entry: LinkEntry) {
  entry.techs.push({ techName: "", params: [] });
  onChange();
}

function removeTech(entry: LinkEntry, ti: number) {
  entry.techs.splice(ti, 1);
  onChange();
}

function addTechParam(entry: LinkEntry, ti: number) {
  entry.techs[ti].params.push({ key: "", value: null });
  onChange();
}

function removeTechParam(entry: LinkEntry, ti: number, pi: number) {
  entry.techs[ti].params.splice(pi, 1);
  onChange();
}

function addExtraParam(entry: LinkEntry) {
  entry.extraParams.push({ key: "", value: null });
  onChange();
}

function removeExtraParam(entry: LinkEntry, j: number) {
  entry.extraParams.splice(j, 1);
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
  <div class="links-editor">
    <template v-if="isLoading">
      <div class="placeholder">Loading links...</div>
    </template>
    <template v-else-if="error">
      <div class="placeholder error">{{ error }}</div>
    </template>
    <template v-else>
      <div class="toolbar">
        <Button label="Save" icon="pi pi-save" size="small" :loading="isSaving" @click="save" />
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
              : 'No links defined. Click "Add link" to create one.'
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
                <span v-if="entry.from || entry.to" class="from-to">
                  {{ entry.from || "?" }} → {{ entry.to || "?" }}
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
                <!-- Name -->
                <div class="field">
                  <label>name</label>
                  <InputText v-model="entry.name" size="small" class="w-full" @input="onChange" />
                </div>

                <!-- from / to -->
                <div class="from-to-row">
                  <div class="field ft-field">
                    <label>from</label>
                    <InputText v-model="entry.from" size="small" class="w-full" @input="onChange" />
                  </div>
                  <div class="field ft-field">
                    <label>to</label>
                    <InputText v-model="entry.to" size="small" class="w-full" @input="onChange" />
                  </div>
                </div>

                <!-- Extra params -->
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

                  <div v-for="(lt, ti) in entry.techs" :key="ti" class="tech-entry">
                    <div class="tech-name-row">
                      <InputText
                        v-model="lt.techName"
                        size="small"
                        placeholder="tech name"
                        class="tech-name-input"
                        @input="onChange"
                      />
                      <Button icon="pi pi-times" size="small" text severity="danger" @click="removeTech(entry, ti)" />
                    </div>
                    <div v-if="lt.params.length > 0" class="tech-params">
                      <div v-for="(p, pi) in lt.params" :key="pi" class="param-row">
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
                      label="Add param"
                      icon="pi pi-plus"
                      size="small"
                      text
                      severity="secondary"
                      class="add-param-btn"
                      @click="addTechParam(entry, ti)"
                    />
                  </div>

                  <div v-if="entry.techs.length === 0" class="sub-placeholder">No inline techs.</div>
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
.links-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.placeholder { padding: 2rem; text-align: center; color: var(--p-text-muted-color, #888); font-size: 0.875rem; }
.placeholder.error { color: #ef4444; }

.toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 1rem;
  flex-shrink: 0;
  border-bottom: 1px solid var(--p-content-border-color, #e0e0e0);
}

.hint { font-size: 0.75rem; color: var(--p-text-muted-color, #888); }

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

.delete-btn { margin-left: auto; }

.entry-form { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem 0; }

.field { display: flex; flex-direction: column; gap: 0.25rem; }
.field label { font-size: 0.8rem; font-family: monospace; color: var(--p-text-muted-color, #666); }

.from-to-row { display: flex; gap: 0.75rem; }
.ft-field { flex: 1; }

.extra-params { display: flex; flex-direction: column; gap: 0.3rem; }

.param-row { display: flex; align-items: flex-start; gap: 0.4rem; }
.param-key { width: 9rem; flex-shrink: 0; }

.sub-section {
  border: 1px solid var(--p-content-border-color, #e0e0e0);
  border-radius: 4px;
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.sub-section-header { display: flex; align-items: center; justify-content: space-between; }
.sub-section-label { font-size: 0.8rem; font-family: monospace; font-weight: 600; color: var(--p-text-muted-color, #666); }

.tech-entry {
  background: var(--p-surface-50, #f9fafb);
  border-radius: 4px;
  padding: 0.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.tech-name-row { display: flex; align-items: center; gap: 0.4rem; }
.tech-name-input { flex: 1; }
.tech-params { display: flex; flex-direction: column; gap: 0.25rem; padding-left: 0.5rem; }
.add-param-btn { align-self: flex-start; }
.sub-placeholder { font-size: 0.8rem; color: var(--p-text-muted-color, #888); text-align: center; padding: 0.25rem; }

.w-full { width: 100%; }
</style>
