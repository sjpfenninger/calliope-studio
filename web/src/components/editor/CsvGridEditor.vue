<script setup lang="ts">
/**
 * A CSV file tab: the grid, a Save button, and the tab's dirty flag.
 *
 * Loading and serialising live in `useCsvGrid`, and the grid itself in
 * `CsvGrid`, because the data-tables view needs both without this component's
 * toolbar. What remains here is only the part that is specific to being a file
 * tab.
 */
import { computed, onMounted, toRef } from "vue";
import StateMessage from "@/components/app/StateMessage.vue";

import CsvGrid from "./CsvGrid.vue";
import EditorToolbar from "./EditorToolbar.vue";
import { useCsvGrid } from "@/composables/useCsvGrid";
import { fileTabId } from "@/lib/tabId";
import { useTabsStore } from "@/stores/tabs";

const props = defineProps<{
  versionId: string | null;
  filePath: string;
}>();

const tabsStore = useTabsStore();
const csv = useCsvGrid(toRef(props, "versionId"));
// Refs are only unwrapped in a template when they are top-level bindings, so the
// ones the template reads are pulled out here rather than reached through `csv`.
const { columnDefs, rowData, isLoading, error } = csv;

const tabId = computed(() => fileTabId(props.filePath));

onMounted(() => csv.load(props.filePath));

function onCellValueChanged() {
  csv.markEdited();
  // A file tab's id is no longer its bare path, so this has to be built. It used
  // to be passed raw, which worked only because the two happened to be the same
  // string — and would now silently mark nothing, leaving the dirty dot off.
  tabsStore.markDirty(tabId.value);
}

async function save() {
  if (!props.versionId) return;
  await tabsStore.saveCsvFile(props.filePath, csv.columns, csv.toRows());
  csv.markSaved();
}

// Keyboard shortcut: Ctrl/Cmd+S
function onKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    save();
  }
}
</script>

<template>
  <!-- design-check: allow focus — a focus *container*, not a control: it takes
       focus so the grid can receive keys, and a ring round a whole pane says nothing. -->
  <div class="flex min-h-0 flex-1 flex-col outline-none" tabindex="-1" @keydown="onKeyDown">
    <StateMessage v-if="isLoading" variant="block" loading>Loading…</StateMessage>
    <StateMessage v-else-if="error" variant="block" tone="danger">{{ error }}</StateMessage>

    <template v-else>
      <EditorToolbar @save="save" />
      <CsvGrid
        :column-defs="columnDefs"
        :row-data="rowData"
        @cell-value-changed="onCellValueChanged"
      />
    </template>
  </div>
</template>
