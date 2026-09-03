<script setup lang="ts">
/**
 * The `data_tables:` section, in two views.
 *
 *   - Section tab (entryName=null): every table in the file, configuration only.
 *   - Entry tab (entryName="cost_parameters"): that table alone, with the CSV
 *     its `table:` points at in an editable grid below it.
 *
 * A data table is a config block *and* a file, and until now the two were
 * reachable only from opposite ends of the app — the config from the Model tree,
 * the CSV from the Files tree, with nothing linking them. The single-table view
 * is where they meet, so Save there writes both.
 */
import { computed, onMounted, onUnmounted, ref, toRef, useTemplateRef, watch } from "vue";
import LockedBanner from "@/components/app/LockedBanner.vue";
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
import { FIELD_LABEL, GHOST_BUTTON, IDENTIFIER } from "@/lib/formClasses";
import { cn } from "@/lib/utils";

import { rowKey } from "@/lib/entries";
import { resolveDataPath } from "@/lib/modelPaths";
import { useCsvGrid } from "@/composables/useCsvGrid";
import { useSectionDataStore } from "@/stores/sectionData";
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
const sectionData = useSectionDataStore();
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

const csv = useCsvGrid(toRef(props, "versionId"), { editable: () => !csvLocked.value });
const {
  columnDefs,
  rowData,
  isLoading: csvLoading,
  error: csvError,
  isDirty: csvDirty,
} = csv;

/**
 * Another buffer — a CSV file tab — holds unsaved changes to the table's file.
 *
 * The YAML section's own lock is the composable's; this is the second file
 * the tab edits, and the single-writer rule applies to it separately.
 */
const csvLocked = computed(
  () => !!csvPath.value && !tabsStore.canEdit(props.tabId, "form", csvPath.value),
);
const csvLockOwner = computed(() =>
  csvLocked.value && csvPath.value ? tabsStore.dirtyOwner(csvPath.value) : null,
);

const csvGrid = useTemplateRef<InstanceType<typeof CsvGrid>>("csvGrid");

/**
 * The CSV reference of one entry: `table:` from Calliope 0.7.0, with the
 * pre-release `data:` spelling read as a fallback so a model awaiting
 * migration still opens its file — the editor has to work on a model that
 * does not build.
 */
function tableRef(entry: { data: Record<string, any> }): unknown {
  return entry.data?.table ?? entry.data?.data;
}

/** Where `table:` points, workspace-relative, or null if there is nothing to open. */
const csvPath = computed(() =>
  activeEntry.value
    ? resolveDataPath(props.filePath, tableRef(activeEntry.value))
    : null
);

/** Why there is no grid, when a single table is shown but `table:` gives nothing. */
const noCsvReason = computed<string | null>(() => {
  if (!activeEntry.value || csvPath.value) return null;
  const raw = tableRef(activeEntry.value);
  if (raw === undefined || raw === null || raw === "") {
    return "This table has no table: file.";
  }
  if (Array.isArray(raw)) {
    return "table: names more than one file — Calliope expects a single path. Edit this table as raw YAML.";
  }
  return "table: points outside the model folder.";
});

/**
 * A path change the grid has not followed yet, because it has unsaved edits.
 *
 * Reloading on a `table:` keystroke would throw away cell edits without asking,
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
  // `table:` is a text field and SchemaObjectEditor emits on every keystroke, so
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

/**
 * Edits land in `useCsvGrid` through the grid's valueSetter; this watch
 * propagates its dirtiness to the tab. The tab is marked as the *form's*
 * source — the grid is part of this tab's work — and as holding the CSV's
 * path, so a CSV file tab on the same file sees it is taken.
 */
let heldCsv: string | null = null;
watch(csvDirty, (dirty) => {
  if (dirty) {
    tabsStore.markDirty(props.tabId, "form");
    heldCsv = csv.loadedPath.value;
    if (heldCsv) tabsStore.holdFile(props.tabId, heldCsv);
  } else if (heldCsv) {
    tabsStore.releaseFile(props.tabId, heldCsv);
    heldCsv = null;
  }
});

// Something else wrote the table's CSV — a file tab on it, say. Re-read it,
// unless the cells here are the user's own unsaved work.
let seenCsvRevision = 0;
watch(
  () => (csv.loadedPath.value ? sectionData.fileRevisions.get(csv.loadedPath.value) ?? 0 : 0),
  (revision) => {
    if (revision === seenCsvRevision) return;
    seenCsvRevision = revision;
    if (!csvDirty.value && csv.loadedPath.value) request(csv.loadedPath.value);
  },
);

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

const formDirty = ref(false);

/** Which keys each table had on load, so a null placeholder is not deleted. */
const loadedKeys = ref<Record<string, Set<string>>>({});
const EMPTY_KEYS: ReadonlySet<string> = new Set();

function touchForm() {
  formDirty.value = true;
  markDirty();
}

function buildPayload(): Record<string, any> {
  const result: Record<string, any> = {};
  for (const e of entries.value) {
    if (!e.name) continue;
    // A null is dropped, because that is how this form says "not set" and the
    // section must not gain an empty key from a field nobody filled in.
    //
    // Except where the file already had one. `add_dims:` written as a bare
    // placeholder parses to null, and stripping it deleted the line — and its
    // comment — out of a save that touched a different field entirely. A key
    // that was there on load stays there.
    const wasPresent = loadedKeys.value[e.name] ?? EMPTY_KEYS;
    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(e.data)) {
      if ((v !== null && v !== undefined) || wasPresent.has(k)) payload[k] = v;
    }
    result[e.name] = payload;
  }
  return result;
}

/**
 * Writes the CSV first, then the YAML.
 *
 * `table:` is the pointer. If the CSV write fails after the YAML write landed,
 * the model names a file whose edits were lost; the other way round leaves at
 * worst an orphan CSV at a path the user just typed, which is visible and
 * recoverable. Cell edits are the expensive thing, so they go first.
 *
 * Neither write happens unless that half is dirty. For the CSV that is a
 * correctness requirement rather than an optimisation: `serialize_csv` rewrites
 * the whole file through `csv.writer`, so a no-op rewrite can still change
 * quoting and line endings.
 */
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
  section: "data_tables",
  label: "data tables",
  apply(data) {
    entries.value = Object.entries(data).map(([name, raw]: [string, any]) => ({
      name,
      data: raw ?? {},
    }));
    loadedKeys.value = Object.fromEntries(
      Object.entries(data).map(([name, raw]) => [
        name,
        new Set(Object.keys((raw as Record<string, unknown>) ?? {})),
      ]),
    );
    formDirty.value = false;
  },
  build: buildPayload,
  /**
   * The CSV goes first, and `table:` is the pointer. If the CSV write fails after
   * the YAML write landed, the model names a file whose edits were lost; the
   * other way round leaves at worst an orphan CSV at a path the user just typed,
   * which is visible and recoverable. Cell edits are the expensive thing.
   */
  async beforeWrite() {
    // An open cell editor is an edit, not a draft: commit it before reading
    // dirtiness. Synchronous — the valueSetter runs inside `stopEditing`.
    csvGrid.value?.commitPendingEdit();
    if (csvDirty.value && csv.loadedPath.value) {
      const path = csv.loadedPath.value;
      await csv.save(path);
      // The CSV file tab on this path, if any, re-reads it.
      sectionData.noteFileWritten(path);
      seenCsvRevision = sectionData.fileRevisions.get(path) ?? 0;
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
          :class="GHOST_BUTTON"
          :disabled="locked"
          @click="addEntry"
        >
          <Plus class="size-3.5" />
          Add table
        </button>
      </EditorToolbar>
      <LockedBanner v-if="lockOwner" :owner="lockOwner" :file="filePath" />

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
          <fieldset :disabled="locked" class="h-full overflow-auto px-2" data-testid="dt-entry">
            <DataTableFields
              :name="activeEntry.name"
              :data="activeEntry.data"
              :form-key="filePath + ':dt:' + rowKey(activeEntry)"
              @update:name="onNameChange(visibleEntries[0].index, $event)"
              @update:data="onEntryDataChange(visibleEntries[0].index, $event)"
            />
          </fieldset>
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
                data: now points at <span :class="IDENTIFIER">{{ pendingPath }}</span
                >.
              </span>
              <button type="button" :class="GHOST_BUTTON" @click="reloadCsv">
                Reload grid
              </button>
              <span class="text-text-faint">discards unsaved cell edits</span>
            </p>

            <LockedBanner
              v-if="csvLockOwner && csvPath"
              :owner="csvLockOwner"
              :file="csvPath"
            />

            <StateMessage v-if="csvLoading" variant="block" loading>
              Loading…
            </StateMessage>
            <StateMessage v-else-if="csvError" variant="block" tone="danger">
              {{ csvError }}
            </StateMessage>
            <CsvGrid v-else ref="csvGrid" :column-defs="columnDefs" :row-data="rowData" />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <!-- One table, but nothing openable at its `data:`. -->
      <div v-else-if="activeEntry" class="min-h-0 flex-1 overflow-auto px-2">
        <div data-testid="dt-entry">
          <DataTableFields
            :name="activeEntry.name"
            :data="activeEntry.data"
            :form-key="filePath + ':dt:' + rowKey(activeEntry)"
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
          :default-value="visibleEntries.map(({ entry }) => rowKey(entry))"
          class="px-2"
        >
          <!-- Keyed by the table's own identity, never by its position.
               `SchemaObjectEditor` keeps text and row drafts seeded once at
               setup and says in its own docblock that it relies on the parent
               remounting it; an index key defeats that, so deleting a table
               handed the next one's data to a component still holding the
               deleted one's drafts. -->
          <EntryAccordionRow
            v-for="{ entry, index } in visibleEntries"
            :key="rowKey(entry)"
            :value="rowKey(entry)"
            :name="entry.name || '(unnamed)'"
            remove-label="Remove this table"
            testid="dt-entry"
            @remove="removeEntry(index)"
          >
              <DataTableFields
                :name="entry.name"
                :data="entry.data"
                :form-key="filePath + ':dt:' + rowKey(entry)"
                @update:name="onNameChange(index, $event)"
                @update:data="onEntryDataChange(index, $event)"
              />
          </EntryAccordionRow>
        </Accordion>
      </div>
    </template>
  </div>
</template>
