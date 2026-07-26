<script setup lang="ts">
/**
 * NodesEditor — accordion-per-node editor for the `nodes:` YAML section.
 *
 * Supports three modes via props:
 *   - Section tab (entryName=null): shows all nodes in the file
 *   - Entry tab (entryName="region1"): shows only the named node
 *   - File structured view (tabId=filePath, entryName=null): shows all nodes
 *
 * Saves always write the full section back to the file.
 */
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { List, Map, Plus, Trash2, X } from "lucide-vue-next";

import client from "@/api/client";
import EditorToolbar from "./EditorToolbar.vue";
import InheritedFields from "./InheritedFields.vue";
import NodesMapView from "./NodesMapView.vue";
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
  ICON_BUTTON,
  SECTION_HEADING,
} from "@/lib/formClasses";
import { ICON_STROKE_WIDTH } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useTabsStore } from "@/stores/tabs";
import { useSectionDataStore } from "@/stores/sectionData";
import { useComponentTreeStore } from "@/stores/componentTree";
import { useUiStore } from "@/stores/ui";
import { nodeToRaw, rawToNode, type NodeEntry } from "@/lib/entries";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabId: string;
  entryName?: string | null;
}>();

const tabsStore = useTabsStore();
const sectionDataStore = useSectionDataStore();
const componentTreeStore = useComponentTreeStore();
const ui = useUiStore();
const isLoading = ref(true);
const isSaving = ref(false);
const error = ref<string | null>(null);

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



async function load() {
  isLoading.value = true;
  error.value = null;
  try {
    const cached = sectionDataStore.get(props.versionId, props.filePath, "nodes");
    if (cached !== null) {
      entries.value = Object.entries(cached).map(([name, raw]) =>
        rawToNode(name, raw as Record<string, any> | null)
      );
    } else {
      const res = await client.get<{ section: string; data: any }>(
        `/api/versions/${props.versionId}/yaml-section/${props.filePath}?section=nodes`
      );
      const d = res.data.data ?? {};
      sectionDataStore.set(props.versionId, props.filePath, "nodes", d);
      entries.value = Object.entries(d).map(([name, raw]) =>
        rawToNode(name, raw as Record<string, any> | null)
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
    result[e.name] = nodeToRaw(e);
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
    tabsStore.markClean(props.tabId);
  } finally {
    isSaving.value = false;
  }
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

/** Data-table values for one node, and which table each came from. */
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

/** A coordinate field writes a number, or null — never the DOM's string. */
function setCoordinate(entry: NodeEntry, key: "latitude" | "longitude", raw: string) {
  const trimmed = raw.trim();
  entry[key] = trimmed === "" ? null : Number(trimmed);
  onChange();
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
  <div class="flex min-h-0 flex-1 flex-col">
    <p v-if="isLoading" class="p-6 text-center text-sm text-muted-foreground">
      Loading nodes…
    </p>
    <p v-else-if="error" class="p-6 text-center text-sm text-danger-text">{{ error }}</p>

    <template v-else>
      <EditorToolbar :saving="isSaving" @save="save">
        <button v-if="!entryName" type="button" :class="GHOST_BUTTON" @click="addEntry">
          <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
          Add node
        </button>
        <button
          v-if="!entryName"
          type="button"
          data-testid="nodes-view"
          :class="GHOST_BUTTON"
          @click="ui.toggleNodesView()"
        >
          <component
            :is="ui.nodesView === 'map' ? List : Map"
            class="size-3.5"
            :stroke-width="ICON_STROKE_WIDTH"
          />
          {{ ui.nodesView === "map" ? "List" : "Map" }}
        </button>
      </EditorToolbar>

      <NodesMapView
        v-if="ui.nodesView === 'map' && !entryName"
        :version-id="versionId"
        class="min-h-0 flex-1"
      />

      <div v-else class="min-h-0 flex-1 overflow-auto">
        <p
          v-if="!visibleEntries.length"
          class="p-6 text-center text-sm text-muted-foreground"
        >
          {{ entryName ? `No node called "${entryName}".` : "No nodes defined yet." }}
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
              <button
                type="button"
                title="Remove this node"
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

                <div class="flex items-center justify-between gap-2">
                  <label :class="FIELD_LABEL">active</label>
                  <Switch v-model="entry.active" @update:model-value="onChange" />
                </div>

                <div class="flex gap-2">
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <label :class="FIELD_LABEL">latitude</label>
                    <input
                      :value="entry.latitude ?? ''"
                      type="number"
                      step="any"
                      min="-90"
                      max="90"
                      :class="FIELD"
                      @change="
                        setCoordinate(
                          entry,
                          'latitude',
                          ($event.target as HTMLInputElement).value,
                        )
                      "
                    />
                  </div>
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <label :class="FIELD_LABEL">longitude</label>
                    <input
                      :value="entry.longitude ?? ''"
                      type="number"
                      step="any"
                      min="-180"
                      max="180"
                      :class="FIELD"
                      @change="
                        setCoordinate(
                          entry,
                          'longitude',
                          ($event.target as HTMLInputElement).value,
                        )
                      "
                    />
                  </div>
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
                      @click="removeExtraParam(entry, j)"
                    >
                      <X class="size-3.5" :stroke-width="2" />
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  :class="cn(GHOST_BUTTON, 'self-start')"
                  @click="addExtraParam(entry)"
                >
                  <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
                  Add parameter
                </button>

                <!-- Per-node technology overrides: the same tech, tuned here. -->
                <div class="flex flex-col gap-1.5 rounded-sm border border-border p-2">
                  <div class="flex items-center justify-between">
                    <span :class="SECTION_HEADING">techs</span>
                    <button
                      type="button"
                      title="Add a technology"
                      :class="ICON_BUTTON"
                      @click="addTech(entry)"
                    >
                      <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
                    </button>
                  </div>

                  <div
                    v-for="(techOvr, ti) in entry.techs"
                    :key="ti"
                    class="flex flex-col gap-1 border-t border-border-subtle pt-1.5 first:border-t-0 first:pt-0"
                  >
                    <div class="flex items-center gap-1">
                      <input
                        v-model="techOvr.techName"
                        type="text"
                        placeholder="tech name"
                        :class="FIELD"
                        @input="onChange"
                      />
                      <button
                        type="button"
                        title="Remove this technology"
                        :class="DANGER_ICON_BUTTON"
                        @click="removeTech(entry, ti)"
                      >
                        <X class="size-3.5" :stroke-width="2" />
                      </button>
                    </div>

                    <div
                      v-for="(p, pi) in techOvr.params"
                      :key="pi"
                      class="flex items-start gap-1"
                    >
                      <input
                        v-model="p.key"
                        type="text"
                        placeholder="parameter"
                        :class="cn(FIELD, 'w-36 shrink-0')"
                        @input="onChange"
                      />
                      <ScalarOrDataVar
                        :model-value="p.value"
                        @update:model-value="
                          p.value = $event;
                          onChange();
                        "
                      />
                      <button
                        type="button"
                        title="Remove this override"
                        :class="DANGER_ICON_BUTTON"
                        @click="removeTechParam(entry, ti, pi)"
                      >
                        <X class="size-3.5" :stroke-width="2" />
                      </button>
                    </div>

                    <button
                      type="button"
                      :class="cn(GHOST_BUTTON, 'self-start')"
                      @click="addTechParam(entry, ti)"
                    >
                      <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
                      Add override
                    </button>
                  </div>

                  <p v-if="!entry.techs.length" class="text-2xs text-text-faint">
                    No techs assigned.
                  </p>
                </div>

                <InheritedFields
                  v-if="entry.template"
                  :label="`From: ${entry.template}`"
                  :fields="templateFields(entry.template)"
                  :is-overridden="(key) => isNodeFieldOverridden(entry, key)"
                  empty-text="Template definition not available."
                />

                <InheritedFields
                  v-if="Object.keys(dataTableParams[entry.name] ?? {}).length"
                  label="From data tables"
                  :fields="dataTableFields(entry.name)"
                  :sources="dataTableSources(entry.name)"
                  :is-overridden="(key) => isNodeFieldOverridden(entry, key)"
                />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </template>
  </div>
</template>
