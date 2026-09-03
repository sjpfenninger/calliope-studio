import { ref, shallowRef, type Ref } from "vue";

import { errorDetail } from "@/api/errors";
import { getCsv, putCsv } from "@/api/versions";

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

export interface CsvGridOptions {
  /**
   * Whether cells take edits. A function, read by the grid per cell, so a lock
   * that arrives after the column definitions were built still applies.
   */
  editable?: () => boolean;
}

/**
 * `errorDetail`, with the one thing this surface knows that it does not.
 *
 * `api/errors.ts` answers a bare 404 as "Not found." because it serves every
 * request in the app; here the only thing that can be missing is the file, and
 * saying so is what makes the message actionable. This used to be a private
 * copy of the whole function, which had drifted from it.
 */
function describe(caught: unknown): string {
  const message = errorDetail(caught, "Failed to load CSV.");
  return message === "Not found." ? "File not found." : message;
}

export function useCsvGrid(versionId: Ref<string | null>, options: CsvGridOptions = {}) {
  const columnDefs = shallowRef<any[]>([]);
  const rowData = shallowRef<Record<string, string>[]>([]);
  const isLoading = ref(false);
  const error = ref<string | null>(null);
  const isDirty = ref(false);
  const loadedPath = ref<string | null>(null);

  // Kept separate from `columnDefs` because it is what a save writes: the
  // header names and their order, exactly as the file had them.
  let columns: CsvColumn[] = [];

  /**
   * Cells past the end of the header, by row index, put back on save.
   *
   * A row longer than its header has nowhere to go in a grid keyed by column,
   * and `toRows` used to map over the header only — so a save quietly cut
   * every such row down to the header's width.
   */
  let overflow = new Map<number, string[]>();

  /** The file's revision as loaded, sent back with a save; see `Revised`. */
  let revision: string | null = null;

  /** Counts edits, so a save can tell whether one landed while it was writing. */
  let edits = 0;

  // A response for a superseded path must not land. The data-tables view
  // reloads whenever `table:` changes, so out-of-order responses are ordinary
  // there rather than exotic.
  let token = 0;

  function reset() {
    columns = [];
    overflow = new Map();
    revision = null;
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
      revision = payload.revision ?? null;
      columnDefs.value = columns.map((col, i) => ({
        field: fieldFor(i),
        headerName: col.name || "(unnamed)",
        editable: () => options.editable?.() ?? true,
        type: col.type === "numeric" ? "numericColumn" : undefined,
        valueSetter: makeValueSetter(fieldFor(i)),
      }));
      overflow = new Map();
      rowData.value = (payload.rows ?? []).map((row, rowIndex) => {
        const obj: Record<string, string> = { [ROW_KEY]: String(rowIndex) };
        columns.forEach((_, i) => {
          obj[fieldFor(i)] = row[i] ?? "";
        });
        if (row.length > columns.length) overflow.set(rowIndex, row.slice(columns.length));
        return obj;
      });
      isDirty.value = false;
      loadedPath.value = path;
    } catch (caught) {
      if (mine !== token) return;
      columns = [];
      columnDefs.value = [];
      rowData.value = [];
      loadedPath.value = null;
      error.value = describe(caught);
    } finally {
      if (mine === token) isLoading.value = false;
    }
  }

  /** The rows as the CSV endpoint wants them: header order, strings. */
  function toRows(): string[][] {
    return rowData.value.map((row) => [
      ...columns.map((_, i) => row[fieldFor(i)] ?? ""),
      ...(overflow.get(Number(row[ROW_KEY])) ?? []),
    ]);
  }

  /** Writes a committed edit into the real rows. Returns whether it landed. */
  function applyEdit(edit: CellEdit): boolean {
    const row = rowData.value[Number(edit.rowKey)];
    if (!row || !(edit.field in row)) return false;
    // In-place on purpose: replacing `rowData.value` would fire the wrapper's
    // prop watcher, which re-clones everything and resets the grid mid-edit.
    row[edit.field] = edit.value == null ? "" : String(edit.value);
    edits += 1;
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

  /**
   * Writes the grid to `path`, carrying the revision it was loaded from.
   *
   * Throws rather than returns when no model is open: a resolved promise reads
   * as "saved" to the caller, which then marks the buffer clean over a file that
   * was never written. An edit committed while the write was in flight keeps
   * the grid dirty, since it is not on disk.
   */
  async function save(path: string): Promise<void> {
    if (!versionId.value) throw new Error("No model is open — nothing was saved.");
    const at = edits;
    const next = await putCsv(versionId.value, path, columns, toRows(), revision);
    if (next) revision = next;
    if (edits === at) isDirty.value = false;
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
    get revision() {
      return revision;
    },
    load,
    toRows,
    applyEdit,
    save,
    markSaved,
  };
}
