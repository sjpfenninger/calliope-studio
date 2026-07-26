<script setup lang="ts">
import { ref, onMounted } from "vue";
import { AgGridVue } from "ag-grid-vue3";
import { AllCommunityModule, ModuleRegistry } from "ag-grid-community";
import client from "@/api/client";
import EditorToolbar from "./EditorToolbar.vue";
import { gridTheme } from "@/lib/agTheme";
import { fileTabId } from "@/lib/tabId";
import { useTabsStore } from "@/stores/tabs";

ModuleRegistry.registerModules([AllCommunityModule]);

const props = defineProps<{
  versionId: string | null;
  filePath: string;
}>();

const tabsStore = useTabsStore();

interface CsvColumn {
  name: string;
  type: "numeric" | "text";
}

const columnDefs = ref<any[]>([]);
const rowData = ref<Record<string, string>[]>([]);
const isLoading = ref(true);
const error = ref<string | null>(null);

let originalColumns: CsvColumn[] = [];

onMounted(async () => {
  if (!props.versionId) return;
  try {
    const res = await client.get<{ columns: CsvColumn[]; rows: string[][] }>(
      `/api/versions/${props.versionId}/csv/${props.filePath}`
    );
    originalColumns = res.data.columns;
    columnDefs.value = res.data.columns.map((col) => ({
      field: col.name,
      headerName: col.name,
      editable: true,
      type: col.type === "numeric" ? "numericColumn" : undefined,
    }));
    rowData.value = res.data.rows.map((row) => {
      const obj: Record<string, string> = {};
      res.data.columns.forEach((col, i) => {
        obj[col.name] = row[i] ?? "";
      });
      return obj;
    });
  } catch (e: any) {
    error.value = e.message ?? "Failed to load CSV";
  } finally {
    isLoading.value = false;
  }
});

function onCellValueChanged() {
  // A file tab's id is no longer its bare path, so this has to be built. It used
  // to be passed raw, which worked only because the two happened to be the same
  // string — and would now silently mark nothing, leaving the dirty dot off.
  tabsStore.markDirty(fileTabId(props.filePath));
}

async function save() {
  if (!props.versionId) return;
  const rows = rowData.value.map((row) =>
    originalColumns.map((col) => row[col.name] ?? "")
  );
  await tabsStore.saveCsvFile(props.filePath, originalColumns, rows);
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
  <div class="flex min-h-0 flex-1 flex-col outline-none" tabindex="-1" @keydown="onKeyDown">
    <p v-if="isLoading" class="p-6 text-center text-sm text-muted-foreground">Loading…</p>
    <p v-else-if="error" class="p-6 text-center text-sm text-danger-text">{{ error }}</p>

    <template v-else>
      <EditorToolbar @save="save" />
      <AgGridVue
        class="min-h-0 flex-1"
        :theme="gridTheme"
        :column-defs="columnDefs"
        :row-data="rowData"
        :default-col-def="{ resizable: true, sortable: true, filter: true }"
        @cell-value-changed="onCellValueChanged"
      />
    </template>
  </div>
</template>
