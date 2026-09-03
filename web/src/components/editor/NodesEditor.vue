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
import { computed, ref, shallowRef } from "vue";
import LockedBanner from "@/components/app/LockedBanner.vue";
import StateMessage from "@/components/app/StateMessage.vue";
// `Map` is aliased so it cannot shadow the global `Map` constructor.
import { List, Map as MapIcon, Plus } from "@lucide/vue";

import { getDataTableParams } from "@/api/versions";
import { useSectionEditor } from "@/composables/useSectionEditor";
import { useTabsStore } from "@/stores/tabs";
import EditorMapPane from "./EditorMapPane.vue";
import EditorToolbar from "./EditorToolbar.vue";
import NodeFields, { type DataTableParam } from "./NodeFields.vue";
import { Accordion } from "@/components/ui/accordion";
import EntryAccordionRow from "./EntryAccordionRow.vue";
import { GHOST_BUTTON, IDENTIFIER } from "@/lib/formClasses";

import { useModelGeo } from "@/composables/useModelGeo";
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
  nodeToRaw,
  rawToNode,
  rowKey,
  type NodeEntry,
} from "@/lib/entries";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabId: string;
  entryName?: string | null;
}>();

const componentTreeStore = useComponentTreeStore();
const templatesStore = useTemplatesStore();
const ui = useUiStore();
// Only for `openEntry`; the dirty/clean bookkeeping is the composable's.
const tabsStore = useTabsStore();

const entries = ref<NodeEntry[]>([]);
/**
 * Which rows are expanded, by `rowKey`.
 *
 * State rather than Reka's `:default-value`, which is read once — and with the
 * rows keyed by identity there is no longer a remount to reseed it. `addEntry`
 * extends it so a new node arrives open.
 */
const openRows = ref<string[]>([]);
const templatesData = computed(() => templatesStore.templates);

// Map from node name → param name → data-table info
const dataTableParams = ref<Record<string, Record<string, DataTableParam>>>({});

const { geo: savedGeo, error: geoError, reload: reloadGeo } = useModelGeo(
  computed(() => props.versionId),
);

/**
 * Which node the map has selected: the entry itself, not its name.
 *
 * Held by identity because the form under the map can *rename* the node it is
 * showing. Looking the selection up by name meant the first keystroke in the
 * name field matched nothing, the detail pane fell through to "Click a node to
 * edit it", and the half-typed name went with it.
 *
 * `activeName` is kept alongside for the one case the entry cannot answer: a
 * node drawn from the saved model that this file does not define, where the
 * pane says which file does.
 */
const activeEntry = shallowRef<NodeEntry | null>(null);
const activeName = ref<string | null>(null);

/**
 * What the map should draw as selected: the entry's *current* name while it is
 * being renamed, since that is the node the map still has under the cursor.
 */
const selectedNames = computed(() => {
  const name = activeEntry.value?.name ?? activeName.value;
  return name ? [name] : [];
});

function select(name: string | null) {
  activeName.value = name;
  activeEntry.value = name
    ? (entries.value.find((entry) => entry.name === name) ?? null)
    : null;
}

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

/** Where a node the map shows but this editor does not own is defined. */
const activeElsewhere = computed(() => {
  if (!activeName.value || activeEntry.value) return null;
  const found = (componentTreeStore.tree?.nodes?.entries ?? []).find(
    (entry) => typeof entry !== "string" && entry.name === activeName.value,
  );
  return typeof found === "string" || !found ? null : found;
});

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
    dataTableParams.value = await getDataTableParams(props.versionId, "node");
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
  section: "nodes",
  label: "nodes",
  async apply(data) {
    entries.value = Object.entries(data).map(([name, raw]) =>
      rawToNode(name, raw as Record<string, any> | null),
    );
    openRows.value = entries.value.map(rowKey);
    // The entries are new objects, so a selection made against the old ones is
    // no longer any of them; re-resolve it by name, which is all a reload can.
    select(activeName.value);
    await loadTemplatesSection();
    await loadDataTableParams();
    // The provenance marker on each field links to the template or table that
    // supplies the value, and the tree is what says which file holds it. Cheap:
    // the store returns immediately once loaded, and the explorer usually has.
    await componentTreeStore.load(props.versionId);
  },
  build: buildPayload,
  async after() {
    // A node added, removed or renamed changes the explorer, and moves the links
    // the server draws between them.
    await componentTreeStore.refresh(props.versionId);
    // A save can change what entries inherit, so the resolved templates the
    // forms display have to be re-read too.
    await templatesStore.refresh(props.versionId);
    await reloadGeo();
  },
});

const onChange = markDirty;

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
  activeEntry.value = entry;
  activeName.value = entry.name;
  onChange();
}

function addEntry() {
  entries.value.push({
    name: "",
    template: null,
    active: true,
    latitude: null,
    longitude: null,
    extraParams: [],
    techs: [],
  });
  openRows.value = [
    ...openRows.value,
    rowKey(entries.value[entries.value.length - 1]),
  ];
  // A node with no name and no coordinates cannot be shown on a map, so adding
  // one is also a request to see the list.
  ui.setSectionView("nodes", "structured");
  onChange();
}

function removeEntry(entry: NodeEntry) {
  const i = entries.value.indexOf(entry);
  if (i !== -1) entries.value.splice(i, 1);
  // By identity: the entry may have been renamed since it was selected.
  if (activeEntry.value === entry) select(null);
  onChange();
}

function openElsewhere() {
  const target = activeElsewhere.value;
  if (target?.file && target.name) {
    tabsStore.openEntry("nodes", target.file, target.name);
  }
}

</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="nodes-editor">
    <StateMessage v-if="isLoading" variant="block" loading>
      Loading nodes…
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
          data-testid="add-node"
          :class="GHOST_BUTTON"
          :disabled="locked"
          @click="addEntry"
        >
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
      <LockedBanner v-if="lockOwner" :owner="lockOwner" :file="filePath" />

      <EditorMapPane
        v-if="showMap"
        :geo="mapGeo"
        :selected="selectedNames"
        :missing="missing"
        :error="geoError"
        :draggable-nodes="!locked"
        @update:selected="select($event[0] ?? null)"
        @node-moved="onNodeMoved"
        @show-list="ui.setSectionView('nodes', 'structured')"
      >
        <template #empty>No nodes yet — add one to place it.</template>

        <template #detail>
          <fieldset v-if="activeEntry" :disabled="locked" class="contents">
            <NodeFields
              :key="rowKey(activeEntry)"
              :entry="activeEntry"
              :templates="templatesData"
              :data-table-params="dataTableParams[activeEntry.name] ?? {}"
              @change="onChange"
            />
          </fieldset>
          <div
            v-else-if="activeElsewhere"
            class="flex items-center gap-2 py-1 text-sm text-text-muted"
          >
            <span>
              <code :class="IDENTIFIER">{{ activeName }}</code> is defined in
              <code :class="IDENTIFIER">{{ activeElsewhere.file }}</code>.
            </span>
            <button type="button" :class="GHOST_BUTTON" @click="openElsewhere">
              Open it
            </button>
          </div>
          <p
            v-else
            class="flex h-full items-center justify-center text-sm text-text-muted"
          >
            Click a node to edit it, or drag one to move it.
          </p>
        </template>
      </EditorMapPane>

      <fieldset v-else :disabled="locked" class="min-h-0 flex-1 overflow-auto">
        <StateMessage v-if="!visibleEntries.length" variant="block">
          {{ entryName ? `No node called "${entryName}".` : "No nodes defined yet." }}
        </StateMessage>

        <Accordion v-else v-model="openRows" type="multiple" class="px-2">
          <EntryAccordionRow
            v-for="entry in visibleEntries"
            :key="rowKey(entry)"
            :value="rowKey(entry)"
            :name="entry.name || '(unnamed)'"
            remove-label="Remove this node"
            testid="entry-row"
            @remove="removeEntry(entry)"
          >

              <NodeFields
                :entry="entry"
                :templates="templatesData"
                :data-table-params="dataTableParams[entry.name] ?? {}"
                @change="onChange"
              />
          </EntryAccordionRow>
        </Accordion>
      </fieldset>
    </template>
  </div>
</template>
