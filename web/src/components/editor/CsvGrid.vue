<script setup lang="ts">
/**
 * The grid itself, and nothing else.
 *
 * Split out of `CsvGridEditor` so the data-tables view can put a CSV under a
 * table's configuration without inheriting that component's toolbar or its
 * "the file tab is mine" dirty wiring. The results table uses it too, which is
 * why the column behaviour is a prop: that one is read-only, and an editable
 * grid over numbers nobody can write back would be a lie about what a cell is.
 *
 * It stays the single place AG Grid is registered and themed. Registering the
 * modules twice is harmless, but two themes are not — see `lib/agTheme.ts`.
 */
import { useTemplateRef } from "vue";
import { AgGridVue } from "ag-grid-vue3";
import {
  AllCommunityModule,
  enableDevValidations,
  ModuleRegistry,
  type ColDef,
  type GridApi,
} from "ag-grid-community";

import { gridTheme } from "@/lib/agTheme";

ModuleRegistry.registerModules([AllCommunityModule]);

// AG Grid 36 stopped bundling its validations in `AllCommunityModule`, so
// without this the grid says nothing at all when it is misconfigured —
// including error #239, which is the one `lib/agTheme.ts` is written around.
// Dev only, because the diagnostics are for whoever is editing this.
if (import.meta.env.DEV) enableDevValidations();

withDefaults(
  defineProps<{
    columnDefs: ColDef[];
    /** Values, not text: the results table holds real numbers so it can sort. */
    rowData: Record<string, unknown>[];
    defaultColDef?: ColDef;
  }>(),
  {
    defaultColDef: () => ({ resizable: true, sortable: true, filter: true }),
  },
);

// ag-grid-vue3 exposes its grid api on the component instance.
const grid = useTemplateRef<{ api: GridApi | undefined }>("grid");

/**
 * Commits an in-flight cell editor, so a save sees the value being typed.
 *
 * Synchronous: the colDef `valueSetter` runs inside `stopEditing`, so the
 * hosting editor's CSV state is correct on the next line. Safe no-op when no
 * cell is being edited — and on the read-only results grid, where nothing
 * ever calls it.
 */
function commitPendingEdit(): void {
  grid.value?.api?.stopEditing();
}

defineExpose({ commitPendingEdit });
</script>

<template>
  <AgGridVue
    ref="grid"
    class="min-h-0 flex-1"
    data-testid="csv-grid"
    :theme="gridTheme"
    :column-defs="columnDefs"
    :row-data="rowData"
    :default-col-def="defaultColDef"
  />
</template>
