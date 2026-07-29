<script setup lang="ts">
/**
 * The `data_tables:` section, in two views.
 *
 *   - Section tab (entryName=null): every table in the file, configuration only.
 *   - Entry tab (entryName="cost_parameters"): that table alone, with the CSV
 *     its `data:` points at in an editable grid below it.
 *
 * A data table is a config block *and* a file, and until now the two were
 * reachable only from opposite ends of the app — the config from the Model tree,
 * the CSV from the Files tree, with nothing linking them. The single-table view
 * is where they meet, so Save there writes both.
 */
import { computed, onMounted, onUnmounted, ref, toRef, watch } from "vue";
import StateMessage from "@/components/app/StateMessage.vue";
import { Plus } from "@lucide/vue";

import { useSectionEditor } from "@/composables/useSectionEditor";
import CsvGrid from "./CsvGrid.vue";
import DataTableFields from "./DataTableFields.vue";
import EditorToolbar from "./EditorToolbar.vue";
import { Accordion } from "@/components/ui/accordion";
import EntryAccordionRow from "./EntryAccordionRow.vue";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { FIELD_LABEL, GHOST_BUTTON } from "@/lib/formClasses";
import { cn } from "@/lib/utils";

import { resolveDataPath } from "@/lib/modelPaths";
import { useCsvGrid } from "@/composables/useCsvGrid";
import { useTabsStore } from "@/stores/tabs";
import { useSchemaStore } from "@/stores/schema";
import { useUiStore } from "@/stores/ui";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabId: string;
  entryName?: string | null;
}>();

const tabsStore = useTabsStore();
const schemaStore = useSchemaStore();
const ui = useUiStore();


// Each entry holds the table name (dict key) and the raw data object from YAML.
// SchemaObjectEditor takes care of the comma-separated and key/value shapes.
interface DataTableEntry {
  name: string;
  data: Record<string, any>;
}

const entries = ref<DataTableEntry[]>([]);

// ---------------------------------------------------------------------------
// One vs all
// ---------------------------------------------------------------------------

/**
 * The entries to show, each with its index into the full `entries` array.
 *
 * The index is carried rather than recomputed because every edit handler writes
 * through it: on an entry tab a filtered `v-for` index is 0 for whichever table
 * was clicked, so passing that would edit the *first* table in the file and save
 * it. Filtering is display-only — the whole section is still what gets written.
 */
const visibleEntries = computed(() =>
  entries.value
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !props.entryName || entry.name === props.entryName)
);

const activeEntry = computed(() =>
  props.entryName ? (visibleEntries.value[0]?.entry ?? null) : null
);

// ---------------------------------------------------------------------------
// The table's CSV
// ---------------------------------------------------------------------------

const csv = useCsvGrid(toRef(props, "versionId"));
const {
  columnDefs,
  rowData,
  isLoading: csvLoading,
  error: csvError,
  isDirty: csvDirty,
} = csv;

/** Where `data:` points, workspace-relative, or null if there is nothing to open. */
const csvPath = computed(() =>
  activeEntry.value
    ? resolveDataPath(props.filePath, activeEntry.value.data?.data)
    : null
);

/** Why there is no grid, when a single table is shown but `data:` gives nothing. */
const noCsvReason = computed<string | null>(() => {
  if (!activeEntry.value || csvPath.value) return null;
  const raw = activeEntry.value.data?.data;
  if (raw === undefined || raw === null || raw === "") {
    return "This table has no data: file.";
  }
  if (Array.isArray(raw)) {
    return "data: names more than one file — Calliope expects a single path. Edit this table as raw YAML.";
  }
  return "data: points outside the model folder.";
});

/**
 * A path change the grid has not followed yet, because it has unsaved edits.
 *
 * Reloading on a `data:` keystroke would throw away cell edits without asking,
 * so a dirty grid stays put and offers the reload instead.
 */
const pendingPath = ref<string | null>(null);

let reloadTimer: ReturnType<typeof setTimeout> | undefined;
// What has been asked for, whether or not it arrived. Tracking the *request*
// rather than `csv.loadedPath` matters for a path that 404s: that leaves
// `loadedPath` null, and comparing against it would re-request on every
// subsequent keystroke.
let requested: string | null = null;
let hasRequested = false;

function request(path: string | null) {
  clearTimeout(reloadTimer);
  requested = path;
  // `data:` is a text field and SchemaObjectEditor emits on every keystroke, so
  // an undebounced watch is one request — and one 404 — per character typed.
  // The first load is not typing, so it does not wait.
  const delay = hasRequested ? 400 : 0;
  hasRequested = true;
  reloadTimer = setTimeout(() => csv.load(path), delay);
}

watch(
  csvPath,
  (next) => {
    if (next === requested) {
      pendingPath.value = null;
      return;
    }
    if (csvDirty.value) {
      // Reloading now would throw away cell edits without asking.
      pendingPath.value = next;
      return;
    }
    pendingPath.value = null;
    request(next);
  },
  { flush: "post", immediate: true }
);

function reloadCsv() {
  const next = pendingPath.value;
  pendingPath.value = null;
  csv.markSaved(); // discarding the edits is the point of the button
  request(next);
}

function onCellValueChanged() {
  csv.markEdited();
  tabsStore.markDirty(props.tabId);
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

const formDirty = ref(false);

function touchForm() {
  formDirty.value = true;
  markDirty();
}

function buildPayload(): Record<string, any> {
  const result: Record<string, any> = {};
  for (const e of entries.value) {
    if (!e.name) continue;
    // Strip null values before saving; preserve everything else as-is.
    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(e.data)) {
      if (v !== null && v !== undefined) payload[k] = v;
    }
    result[e.name] = payload;
  }
  return result;
}

/**
 * Writes the CSV first, then the YAML.
 *
 * `data:` is the pointer. If the CSV write fails after the YAML write landed,
 * the model names a file whose edits were lost; the other way round leaves at
 * worst an orphan CSV at a path the user just typed, which is visible and
 * recoverable. Cell edits are the expensive thing, so they go first.
 *
 * Neither write happens unless that half is dirty. For the CSV that is a
 * correctness requirement rather than an optimisation: `serialize_csv` rewrites
 * the whole file through `csv.writer`, so a no-op rewrite can still change
 * quoting and line endings.
 */
const { isLoading, isSaving, error, saveError, save, markDirty } = useSectionEditor({
  versionId: () => props.versionId,
  filePath: () => props.filePath,
  tabId: () => props.tabId,
  section: "data_tables",
  label: "data tables",
  apply(data) {
    entries.value = Object.entries(data).map(([name, raw]: [string, any]) => ({
      name,
      data: raw ?? {},
    }));
    formDirty.value = false;
  },
  build: buildPayload,
  /**
   * The CSV goes first, and `data:` is the pointer. If the CSV write fails after
   * the YAML write landed, the model names a file whose edits were lost; the
   * other way round leaves at worst an orphan CSV at a path the user just typed,
   * which is visible and recoverable. Cell edits are the expensive thing.
   */
  async beforeWrite() {
    if (csvDirty.value && csv.loadedPath.value) {
      await tabsStore.saveCsvFile(csv.loadedPath.value, csv.columns, csv.toRows());
      csv.markSaved();
    }
  },
  /**
   * Neither half is written unless it is dirty. `serialize_csv` rewrites the
   * whole file through `csv.writer`, so a no-op rewrite can still change quoting
   * and line endings — which makes this a correctness requirement rather than an
   * optimisation, and is what `save-check` asserts.
   */
  shouldWrite: () => formDirty.value,
  after(written) {
    if (written) formDirty.value = false;
  },
});

// ---------------------------------------------------------------------------
// Entry management
// ---------------------------------------------------------------------------

function addEntry() {
  entries.value.push({ name: "", data: {} });
  touchForm();
}

function removeEntry(index: number) {
  entries.value.splice(index, 1);
  touchForm();
}

function onNameChange(index: number, name: string) {
  entries.value[index].name = name;
  touchForm();
}

function onEntryDataChange(index: number, data: Record<string, any>) {
  entries.value[index].data = data;
  touchForm();
}

// ---------------------------------------------------------------------------
// Keyboard shortcut
// ---------------------------------------------------------------------------

// The section load, its keybinding and its cleanup are the composable's — that
// listener leak (opening the overview and then a single table leaves two alive,
// and Cmd+S saves the destroyed component's stale entries over the live one's)
// is now impossible to reintroduce per editor. The CSV follows from `data:`, so
// the watch above picks it up once the section has loaded.
onMounted(() => void schemaStore.load());
onUnmounted(() => clearTimeout(reloadTimer));
</script>

<template>
  <!-- h-full, unlike its sibling editors: the splitter below sizes its panels as
       a fraction of this element, and `flex-1` inside the host's block-level
       wrapper leaves it at content height, which would collapse the grid. -->
  <div class="flex h-full min-h-0 flex-col">
    <StateMessage v-if="isLoading" variant="block" loading>
      Loading data_tables…
    </StateMessage>
    <StateMessage v-else-if="error" variant="block" tone="danger">{{ error }}</StateMessage>

    <template v-else>
      <EditorToolbar :saving="isSaving" :error="saveError" :file="filePath" @save="save">
        <button
          v-if="!entryName"
          type="button"
          :class="GHOST_BUTTON"
          @click="addEntry"
        >
          <Plus class="size-3.5" />
          Add table
        </button>
      </EditorToolbar>

      <StateMessage v-if="!visibleEntries.length" variant="block">
        {{
          entryName
            ? `No data table called "${entryName}".`
            : "No data tables defined yet."
        }}
      </StateMessage>

      <!-- One table: its configuration above, its CSV below. -->
      <ResizablePanelGroup
        v-else-if="activeEntry && csvPath"
        direction="vertical"
        class="min-h-0 flex-1"
        @layout="ui.setDataTableSplit($event)"
      >
        <ResizablePanel :default-size="ui.dataTableSplit[0]" :min-size="20">
          <div class="h-full overflow-auto px-2" data-testid="dt-entry">
            <DataTableFields
              :name="activeEntry.name"
              :data="activeEntry.data"
              :form-key="filePath + ':dt:' + visibleEntries[0].index"
              @update:name="onNameChange(visibleEntries[0].index, $event)"
              @update:data="onEntryDataChange(visibleEntries[0].index, $event)"
            />
          </div>
        </ResizablePanel>

        <ResizableHandle with-handle />

        <ResizablePanel :default-size="ui.dataTableSplit[1]" :min-size="20">
          <div class="flex h-full min-h-0 flex-col">
            <!-- A file path is an identifier, so it gets the same treatment as
                 the key of a field: mono, at the mono step. -->
            <div
              :class="
                cn(
                  'flex h-6 shrink-0 items-center gap-2 border-b border-border px-2',
                  FIELD_LABEL,
                )
              "
            >
              <span class="truncate">{{ csvPath }}</span>
            </div>

            <p
              v-if="pendingPath"
              class="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 text-2xs text-text-dim"
            >
              <span class="truncate">
                data: now points at <span class="font-mono">{{ pendingPath }}</span
                >.
              </span>
              <button type="button" :class="GHOST_BUTTON" @click="reloadCsv">
                Reload grid
              </button>
              <span class="text-text-faint">discards unsaved cell edits</span>
            </p>

            <StateMessage v-if="csvLoading" variant="block" loading>
              Loading…
            </StateMessage>
            <StateMessage v-else-if="csvError" variant="block" tone="danger">
              {{ csvError }}
            </StateMessage>
            <CsvGrid
              v-else
              :column-defs="columnDefs"
              :row-data="rowData"
              @cell-value-changed="onCellValueChanged"
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <!-- One table, but nothing openable at its `data:`. -->
      <div v-else-if="activeEntry" class="min-h-0 flex-1 overflow-auto px-2">
        <div data-testid="dt-entry">
          <DataTableFields
            :name="activeEntry.name"
            :data="activeEntry.data"
            :form-key="filePath + ':dt:' + visibleEntries[0].index"
            @update:name="onNameChange(visibleEntries[0].index, $event)"
            @update:data="onEntryDataChange(visibleEntries[0].index, $event)"
          />
        </div>
        <p class="border-t border-border px-1 py-2 text-2xs text-text-dim">
          {{ noCsvReason }}
        </p>
      </div>

      <!-- Every table in the file. -->
      <div v-else class="min-h-0 flex-1 overflow-auto">
        <Accordion
          type="multiple"
          :default-value="visibleEntries.map(({ index }) => String(index))"
          class="px-2"
        >
          <EntryAccordionRow
            v-for="{ entry, index } in visibleEntries"
            :key="index"
            :value="String(index)"
            :name="entry.name || '(unnamed)'"
            remove-label="Remove this table"
            testid="dt-entry"
            @remove="removeEntry(index)"
          >
              <DataTableFields
                :name="entry.name"
                :data="entry.data"
                :form-key="filePath + ':dt:' + index"
                @update:name="onNameChange(index, $event)"
                @update:data="onEntryDataChange(index, $event)"
              />
          </EntryAccordionRow>
        </Accordion>
      </div>
    </template>
  </div>
</template>
