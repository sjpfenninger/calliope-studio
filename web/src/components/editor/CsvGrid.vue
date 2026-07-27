<script setup lang="ts">
/**
 * The grid itself, and nothing else.
 *
 * Split out of `CsvGridEditor` so the data-tables view can put a CSV under a
 * table's configuration without inheriting that component's toolbar or its
 * "the file tab is mine" dirty wiring.
 */
import { AgGridVue } from "ag-grid-vue3";
import { AllCommunityModule, ModuleRegistry } from "ag-grid-community";

import { gridTheme } from "@/lib/agTheme";

ModuleRegistry.registerModules([AllCommunityModule]);

defineProps<{
  columnDefs: any[];
  rowData: Record<string, string>[];
}>();

defineEmits<{ cellValueChanged: [] }>();
</script>

<template>
  <AgGridVue
    class="min-h-0 flex-1"
    data-testid="csv-grid"
    :theme="gridTheme"
    :column-defs="columnDefs"
    :row-data="rowData"
    :default-col-def="{ resizable: true, sortable: true, filter: true }"
    @cell-value-changed="$emit('cellValueChanged')"
  />
</template>
