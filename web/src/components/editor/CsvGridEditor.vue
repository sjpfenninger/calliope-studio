<script setup lang="ts">
/**
 * A CSV file tab: the grid, a Save button, and the tab's dirty flag.
 *
 * Loading and serialising live in `useCsvGrid`, and the grid itself in
 * `CsvGrid`, because the data-tables view needs both without this component's
 * toolbar. What remains here is only the part that is specific to being a file
 * tab.
 */
import { computed, onMounted, ref, toRef, useTemplateRef, watch } from "vue";
import StateMessage from "@/components/app/StateMessage.vue";

import CsvGrid from "./CsvGrid.vue";
import EditorToolbar from "./EditorToolbar.vue";
import { errorDetail } from "@/api/errors";
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
const { columnDefs, rowData, isLoading, error, isDirty } = csv;

const csvGrid = useTemplateRef<InstanceType<typeof CsvGrid>>("csvGrid");

const tabId = computed(() => fileTabId(props.filePath));

onMounted(() => csv.load(props.filePath));

// Edits land in `useCsvGrid` through the grid's valueSetter; this watch only
// propagates its dirtiness to the tab. The tab id is minted from the path —
// both are strings, so passing the bare path would typecheck and silently
// mark nothing.
watch(isDirty, (dirty) => {
  if (dirty) tabsStore.markDirty(tabId.value);
});

const isSaving = ref(false);
const saveError = ref<string | null>(null);

async function save(): Promise<void> {
  // An open cell editor is an edit, not a draft: commit it before reading.
  csvGrid.value?.commitPendingEdit();
  // A no-op save must not rewrite the file — `serialize_csv` can change quoting
  // on a byte-identical grid.
  if (!isDirty.value) return;
  isSaving.value = true;
  saveError.value = null;
  try {
    await tabsStore.saveCsvFile(props.filePath, csv.columns, csv.toRows());
    csv.markSaved();
  } catch (caught) {
    saveError.value = errorDetail(caught, "Failed to save CSV.");
  } finally {
    isSaving.value = false;
  }
}

// Keyboard shortcut: Ctrl/Cmd+S. `save` reports its own failures, so the
// promise can be discarded.
function onKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    void save();
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
      <EditorToolbar
        :file="filePath"
        :saving="isSaving"
        :error="saveError"
        @save="save"
      />
      <CsvGrid ref="csvGrid" :column-defs="columnDefs" :row-data="rowData" />
    </template>
  </div>
</template>
