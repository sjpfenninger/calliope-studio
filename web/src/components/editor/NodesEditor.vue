<script setup lang="ts">
/**
 * NodesEditor — the `nodes:` YAML section, as a map or as a list.
 *
 * Supports three modes via props:
 *   - Section tab (entryName=null): every node in the file, map or list
 *   - Entry tab (entryName="region1"): only the named node, list
 *   - File structured view (tabId=filePath, entryName=null): every node
 *
 * Saves always write the full section back to the file.
 *
 * The map is the default view and is an editing surface: dragging a node writes
 * its coordinates, clicking one opens its form underneath. Its geometry is built
 * from `entries` rather than fetched, so an unsaved drag or a half-typed
 * coordinate shows immediately — and links attached to a node being dragged
 * follow it, because they are rebuilt from the same positions. What the server
 * payload is for is the rest of the model: the links, and any node defined in a
 * file this editor did not load, which is drawn but not movable.
 */
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import StateMessage from "@/components/app/StateMessage.vue";
// `Map` is aliased so it cannot shadow the global `Map` constructor.
import { List, Map as MapIcon, Plus, Trash2 } from "@lucide/vue";

import client from "@/api/client";
import EditorMapPane from "./EditorMapPane.vue";
import EditorToolbar from "./EditorToolbar.vue";
import NodeFields, { type DataTableParam } from "./NodeFields.vue";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { DANGER_ICON_BUTTON, GHOST_BUTTON } from "@/lib/formClasses";

import { useModelGeo } from "@/composables/useModelGeo";
import { useTabsStore } from "@/stores/tabs";
import { useSectionDataStore } from "@/stores/sectionData";
import { useComponentTreeStore } from "@/stores/componentTree";
import { useTemplatesStore } from "@/stores/templates";
import { useUiStore } from "@/stores/ui";
import {
  buildGeo,
  coordinatesFrom,
  linksFromFeatures,
  missingCoordinates,
  nodesFromFeatures,
  type MapNode,
} from "@/lib/mapGeo";
import {
  entryKey,
  nodeToRaw,
  rawToNode,
  type NodeEntry,
} from "@/lib/entries";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabId: string;
  entryName?: string | null;
}>();

const tabsStore = useTabsStore();
const sectionDataStore = useSectionDataStore();
const componentTreeStore = useComponentTreeStore();
const templatesStore = useTemplatesStore();
const ui = useUiStore();
const isLoading = ref(true);
const isSaving = ref(false);
const error = ref<string | null>(null);

const entries = ref<NodeEntry[]>([]);
const templatesData = computed(() => templatesStore.templates);

// Map from node name → param name → data-table info
const dataTableParams = ref<Record<string, Record<string, DataTableParam>>>({});

const { geo: savedGeo, error: geoError, reload: reloadGeo } = useModelGeo(
  computed(() => props.versionId),
);

/** Which node the map has selected, and so whose form is shown below it. */
const activeNode = ref<string | null>(null);

// When entryName is set (entry tab), show only the matching entry
const visibleEntries = computed(() =>
  props.entryName
    ? entries.value.filter((e) => e.name === props.entryName)
    : entries.value
);

/** The map only makes sense for a whole section. */
const showMap = computed(() => !props.entryName && ui.sectionView.nodes === "map");

/**
 * Every node on the map: this file's, plus the ones defined elsewhere.
 *
 * Only the former are `editable` — moving a node defined in another file would
 * mean writing to a section this editor never loaded, and silently editing a file
 * the user is not looking at is worse than not offering to.
 *
 * A node's position may come from a data table rather than from these fields, so
 * the form's own value only *wins* — it does not decide whether there is one.
 * Dragging such a node writes a YAML coordinate that overrides the table, which
 * is the same precedence Calliope applies and is shown as an override in the
 * form's "From data tables" list.
 */
const mapNodes = computed<MapNode[]>(() => {
  const mine = entries.value
    .filter((entry) => entry.name)
    .map((entry) => {
      const table = coordinatesFrom(dataTableParams.value[entry.name]);
      return {
        name: entry.name,
        latitude: entry.latitude ?? table.latitude,
        longitude: entry.longitude ?? table.longitude,
        editable: true,
      };
    });
  const names = new Set(mine.map((node) => node.name));
  const elsewhere = nodesFromFeatures(savedGeo.value?.nodes).filter(
    (node) => !names.has(node.name),
  );
  return [...mine, ...elsewhere];
});

const mapGeo = computed(() =>
  buildGeo(
    mapNodes.value,
    linksFromFeatures(savedGeo.value?.links),
    savedGeo.value?.colors,
  ),
);

const missing = computed(() => missingCoordinates(mapNodes.value));

const activeEntry = computed(() =>
  entries.value.find((entry) => entry.name === activeNode.value) ?? null,
);

/** Where a node the map shows but this editor does not own is defined. */
const activeElsewhere = computed(() => {
  if (!activeNode.value || activeEntry.value) return null;
  const found = (componentTreeStore.tree?.nodes?.entries ?? []).find(
    (entry) => typeof entry !== "string" && entry.name === activeNode.value,
  );
  return typeof found === "string" || !found ? null : found;
});

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

/**
 * The model's templates, resolved.
 *
 * From the store rather than merged out of each file's raw `templates:` section:
 * that only ever resolved one hop, so a template inheriting a template showed half
 * of what an entry inherits — and made this editor's own idea of what a
 * transmission tech is disagree with Calliope's.
 */
async function loadTemplatesSection() {
  await templatesStore.load(props.versionId);
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
    // A node added, removed or renamed changes the explorer, and moves the links
    // the server draws between them.
    await componentTreeStore.refresh(props.versionId);
    // A save can change what entries inherit, so the resolved templates the
    // forms display have to be re-read too.
    await templatesStore.refresh(props.versionId);
    await reloadGeo();
  } finally {
    isSaving.value = false;
  }
}

function onChange() {
  tabsStore.markDirty(props.tabId);
}

/**
 * A node was dragged to a new position.
 *
 * Rounded to five decimals — about a metre. Dragging produces the full float the
 * projection happens to yield, and fifteen digits of it in a YAML file that a
 * person also reads and hand-edits is noise.
 */
function onNodeMoved(move: { node: string; latitude: number; longitude: number }) {
  const entry = entries.value.find((candidate) => candidate.name === move.node);
  if (!entry) return;
  entry.latitude = Number(move.latitude.toFixed(5));
  entry.longitude = Number(move.longitude.toFixed(5));
  activeNode.value = entry.name;
  onChange();
}

function addEntry() {
  entries.value.push({ name: "", template: null, active: true, latitude: null, longitude: null, extraParams: [], techs: [] });
  // A node with no name and no coordinates cannot be shown on a map, so adding
  // one is also a request to see the list.
  ui.setSectionView("nodes", "structured");
  onChange();
}

function removeEntry(entry: NodeEntry) {
  const i = entries.value.indexOf(entry);
  if (i !== -1) entries.value.splice(i, 1);
  if (activeNode.value === entry.name) activeNode.value = null;
  onChange();
}

function openElsewhere() {
  const target = activeElsewhere.value;
  if (target?.file && target.name) {
    tabsStore.openEntry("nodes", target.file, target.name);
  }
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
    <StateMessage v-if="isLoading" variant="block" loading>
      Loading nodes…
    </StateMessage>
    <StateMessage v-else-if="error" variant="block" tone="danger">{{ error }}</StateMessage>

    <template v-else>
      <EditorToolbar :saving="isSaving" @save="save">
        <button v-if="!entryName" type="button" :class="GHOST_BUTTON" @click="addEntry">
          <Plus class="size-3.5" />
          Add node
        </button>
        <button
          v-if="!entryName"
          type="button"
          data-testid="view-toggle"
          :class="GHOST_BUTTON"
          @click="ui.toggleSectionView('nodes')"
        >
          <component
            :is="showMap ? List : MapIcon"
            class="size-3.5"
          />
          {{ showMap ? "List" : "Map" }}
        </button>
      </EditorToolbar>

      <EditorMapPane
        v-if="showMap"
        :geo="mapGeo"
        :selected="activeNode ? [activeNode] : []"
        :missing="missing"
        :error="geoError"
        draggable-nodes
        @update:selected="activeNode = $event[0] ?? null"
        @node-moved="onNodeMoved"
        @show-list="ui.setSectionView('nodes', 'structured')"
      >
        <template #empty>No nodes yet — add one to place it.</template>

        <template #detail>
          <NodeFields
            v-if="activeEntry"
            :key="activeEntry.name"
            :entry="activeEntry"
            :templates="templatesData"
            :data-table-params="dataTableParams[activeEntry.name] ?? {}"
            @change="onChange"
          />
          <div
            v-else-if="activeElsewhere"
            class="flex items-center gap-2 py-1 text-sm text-muted-foreground"
          >
            <span>
              <code class="font-mono">{{ activeNode }}</code> is defined in
              <code class="font-mono">{{ activeElsewhere.file }}</code>.
            </span>
            <button type="button" :class="GHOST_BUTTON" @click="openElsewhere">
              Open it
            </button>
          </div>
          <p
            v-else
            class="flex h-full items-center justify-center text-sm text-muted-foreground"
          >
            Click a node to edit it, or drag one to move it.
          </p>
        </template>
      </EditorMapPane>

      <div v-else class="min-h-0 flex-1 overflow-auto">
        <StateMessage v-if="!visibleEntries.length" variant="block">
          {{ entryName ? `No node called "${entryName}".` : "No nodes defined yet." }}
        </StateMessage>

        <Accordion
          v-else
          type="multiple"
          :default-value="visibleEntries.map((e) => entryKey(e, entries))"
          class="px-2"
        >
          <AccordionItem
            v-for="entry in visibleEntries"
            :key="entryKey(entry, entries)"
            :value="entryKey(entry, entries)"
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
                <Trash2 class="size-3.5" />
              </button>
            </div>

            <AccordionContent>
              <NodeFields
                :entry="entry"
                :templates="templatesData"
                :data-table-params="dataTableParams[entry.name] ?? {}"
                @change="onChange"
              />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </template>
  </div>
</template>
