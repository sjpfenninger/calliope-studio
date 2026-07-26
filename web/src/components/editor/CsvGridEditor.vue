<script setup lang="ts">
import { ref, onMounted } from "vue";
import { AgGridVue } from "ag-grid-vue3";
import { AllCommunityModule, ModuleRegistry } from "ag-grid-community";
import client from "../../api/client";
import { gridTheme } from "../../lib/agTheme";
import { useEditorStore } from "../../stores/editor";

ModuleRegistry.registerModules([AllCommunityModule]);

const props = defineProps<{
  versionId: string | null;
  filePath: string;
}>();

const editorStore = useEditorStore();

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
  editorStore.markDirty(props.filePath);
}

async function save() {
  if (!props.versionId) return;
  const rows = rowData.value.map((row) =>
    originalColumns.map((col) => row[col.name] ?? "")
  );
  await editorStore.saveCsvFile(props.filePath, originalColumns, rows);
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
  <div class="csv-editor" @keydown="onKeyDown" tabindex="-1">
    <div v-if="isLoading" class="csv-status">Loading…</div>
    <div v-else-if="error" class="csv-status csv-error">{{ error }}</div>
    <template v-else>
      <div class="csv-toolbar">
        <button class="save-btn" @click="save">Save</button>
      </div>
      <AgGridVue
        class="csv-grid"
        :theme="gridTheme"
        :columnDefs="columnDefs"
        :rowData="rowData"
        :defaultColDef="{ resizable: true, sortable: true, filter: true }"
        @cellValueChanged="onCellValueChanged"
      />
    </template>
  </div>
</template>

<style scoped>
.csv-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  outline: none;
}

.csv-status {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--p-text-muted-color, #888);
  font-size: 0.875rem;
}

.csv-error {
  color: var(--p-red-500, #ef4444);
}

.csv-toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--p-content-border-color, #e0e0e0);
  flex-shrink: 0;
}

.save-btn {
  padding: 0.2rem 0.75rem;
  font-size: 0.8rem;
  cursor: pointer;
  border-radius: 4px;
  border: 1px solid var(--p-content-border-color, #ccc);
  background: var(--p-surface-100, #f3f4f6);
}

.csv-grid {
  flex: 1;
}
</style>
