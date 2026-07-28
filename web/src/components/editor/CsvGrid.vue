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
import { AgGridVue } from "ag-grid-vue3";
import { AllCommunityModule, ModuleRegistry, type ColDef } from "ag-grid-community";

import { gridTheme } from "@/lib/agTheme";

ModuleRegistry.registerModules([AllCommunityModule]);

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

defineEmits<{ cellValueChanged: [] }>();
</script>

<template>
  <AgGridVue
    class="min-h-0 flex-1"
    data-testid="csv-grid"
    :theme="gridTheme"
    :column-defs="columnDefs"
    :row-data="rowData"
    :default-col-def="defaultColDef"
    @cell-value-changed="$emit('cellValueChanged')"
  />
</template>
