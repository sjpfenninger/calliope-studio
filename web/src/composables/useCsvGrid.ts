import { ref, shallowRef, type Ref } from "vue";

import { getCsv } from "@/api/versions";

/**
 * Loads a CSV into AG Grid shape, and serialises it back unchanged.
 *
 * Lifted out of `CsvGridEditor` so a data table can show its own CSV without
 * that component's assumption that it *is* the tab: the standalone editor marks
 * a file tab dirty, whereas an embedded grid's dirt belongs to whichever tab is
 * hosting it. Nothing here touches the tabs store; the caller owns that, and
 * owns the Save button.
 *
 * It is also the only shape in which the round-trip can be unit-tested, which
 * matters more than it sounds — see the column keying below.
 */

export interface CsvColumn {
  name: string;
  type: "numeric" | "text";
}

/**
 * The AG Grid field name for column `i`.
 *
 * Positional, *not* the column's own name. A CSV header may repeat a name —
 * `example-model/data_tables/time_varying_params.csv` has its long "Heat output
 * in kW per m2 solar field…" comment three times over and "Time series in kWh…"
 * twice — and keying rows by name collapsed those into one property each. Saving
 * then wrote the last collapsed value back into all of them, silently
 * overwriting region1's `sink_use_equals` with region2's for every timestep.
 *
 * Prefixed rather than a bare `${i}`: AG Grid reads `field` as a path
 * expression, so numeric-looking keys are asking for trouble.
 */
function fieldFor(i: number): string {
  return `c${i}`;
}

/**
 * The hidden per-row identity field.
 *
 * ag-grid-vue3 deep-clones `rowData` before handing it to the grid, so the row
 * objects AG Grid commits edits into are not the ones `toRows()` reads. The
 * stamp travels into those clones and is what lets a committed value find its
 * way back to the real row, whatever order sorting displays it in.
 *
 * String-keyed on purpose: the wrapper's clone copies `Object.keys` only, so a
 * Symbol would be dropped.
 */
const ROW_KEY = "__row";

export interface CellEdit {
  /** `params.data[ROW_KEY]` — survives the wrapper's clone. */
  rowKey: string;
  /** Positional `c${i}`. */
  field: string;
  /** May be null: a cleared cell, numericColumn included. */
  value: unknown;
}

function describe(e: any): string {
  const status = e?.response?.status;
  const detail = e?.response?.data?.detail;
  if (detail) return String(detail);
  if (status === 404) return "File not found.";
  if (status) return `Request failed (${status}).`;
  return e?.message ?? "Failed to load CSV.";
}

export function useCsvGrid(versionId: Ref<string | null>) {
  const columnDefs = shallowRef<any[]>([]);
  const rowData = shallowRef<Record<string, string>[]>([]);
  const isLoading = ref(false);
  const error = ref<string | null>(null);
  const isDirty = ref(false);
  const loadedPath = ref<string | null>(null);

  // Kept separate from `columnDefs` because it is what a save writes: the
  // header names and their order, exactly as the file had them.
  let columns: CsvColumn[] = [];

  // A response for a superseded path must not land. The data-tables view
  // reloads whenever `data:` changes, so out-of-order responses are ordinary
  // there rather than exotic.
  let token = 0;

  function reset() {
    columns = [];
    columnDefs.value = [];
    rowData.value = [];
    isDirty.value = false;
    error.value = null;
    loadedPath.value = null;
  }

  async function load(path: string | null): Promise<void> {
    const mine = ++token;
    if (!versionId.value || !path) {
      reset();
      isLoading.value = false;
      return;
    }

    isLoading.value = true;
    error.value = null;
    try {
      const payload = await getCsv(versionId.value!, path);
      if (mine !== token) return;

      columns = (payload.columns as CsvColumn[]) ?? [];
      columnDefs.value = columns.map((col, i) => ({
        field: fieldFor(i),
        headerName: col.name || "(unnamed)",
        editable: true,
        type: col.type === "numeric" ? "numericColumn" : undefined,
        valueSetter: makeValueSetter(fieldFor(i)),
      }));
      rowData.value = (payload.rows ?? []).map((row, rowIndex) => {
        const obj: Record<string, string> = { [ROW_KEY]: String(rowIndex) };
        columns.forEach((_, i) => {
          obj[fieldFor(i)] = row[i] ?? "";
        });
        return obj;
      });
      isDirty.value = false;
      loadedPath.value = path;
    } catch (e: any) {
      if (mine !== token) return;
      columns = [];
      columnDefs.value = [];
      rowData.value = [];
      loadedPath.value = null;
      error.value = describe(e);
    } finally {
      if (mine === token) isLoading.value = false;
    }
  }

  /** The rows as the CSV endpoint wants them: header order, strings. */
  function toRows(): string[][] {
    return rowData.value.map((row) => columns.map((_, i) => row[fieldFor(i)] ?? ""));
  }

  /** Writes a committed edit into the real rows. Returns whether it landed. */
  function applyEdit(edit: CellEdit): boolean {
    const row = rowData.value[Number(edit.rowKey)];
    if (!row || !(edit.field in row)) return false;
    // In-place on purpose: replacing `rowData.value` would fire the wrapper's
    // prop watcher, which re-clones everything and resets the grid mid-edit.
    row[edit.field] = edit.value == null ? "" : String(edit.value);
    isDirty.value = true;
    return true;
  }

  /**
   * The colDef `valueSetter` for one positional column.
   *
   * This is the write-back channel — chosen over the `cellValueChanged` event
   * because AG Grid dispatches that event *asynchronously*, so a save that runs
   * right after `stopEditing()` would still read pre-edit state. A valueSetter
   * runs synchronously inside the commit.
   *
   * Structural param type, not AG Grid's `ValueSetterParams`: keeps this module
   * grid-free and the setter callable from a unit test.
   */
  function makeValueSetter(field: string) {
    return (params: { data: Record<string, string>; newValue: unknown }): boolean => {
      const text = params.newValue == null ? "" : String(params.newValue);
      // Enter on an untouched cell is not an edit; dirtying here would make the
      // next save rewrite (and re-quote) a file whose content did not change.
      if ((params.data[field] ?? "") === text) return false;
      if (!applyEdit({ rowKey: params.data[ROW_KEY], field, value: text })) return false;
      params.data[field] = text; // the grid's private clone — keeps the cell rendering
      return true;
    };
  }

  function markSaved() {
    isDirty.value = false;
  }

  return {
    columnDefs,
    rowData,
    isLoading,
    error,
    isDirty,
    loadedPath,
    get columns() {
      return columns;
    },
    load,
    toRows,
    applyEdit,
    markSaved,
  };
}
