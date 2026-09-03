/**
 * Stands in for `components/editor/CsvGrid.vue` under vitest.
 *
 * The real grid is AG Grid, which measures a viewport a headless DOM does not
 * have. `DataTablesEditor` reaches it two ways: the `columnDefs`/`rowData`
 * props, which are `useCsvGrid`'s and carry the `valueSetter` a test can drive
 * a cell edit through, and the exposed `commitPendingEdit`, which a save calls
 * before reading dirtiness. Both are here; nothing draws.
 */
import { defineComponent, h } from "vue";

export default defineComponent({
  name: "CsvGridStub",
  props: {
    columnDefs: { type: Array, default: () => [] },
    rowData: { type: Array, default: () => [] },
  },
  setup(_, { expose }) {
    expose({ commitPendingEdit: () => {} });
    return () => h("div", { "data-testid": "csv-grid" });
  },
});
