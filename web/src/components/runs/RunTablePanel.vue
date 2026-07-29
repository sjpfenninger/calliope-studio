<script setup lang="ts">
/**
 * The numbers behind one set of results.
 *
 * Calligraph v0.2.0 had this and this project did not: a variable picker over the whole
 * catalogue, the shared filters, and a way to get the values out. Everything a
 * chart hides — an exact figure, a series too small to see, an input parameter
 * that is not plotted at all — is here.
 *
 * It is a *sibling* of `RunResultsPanel`, not a child, so it cannot inject the
 * selection store and resolves it itself. `useRunSelection` is memoised on the
 * handle, so that is the same store instance the charts are using, which is what
 * makes a filter set on Results already in force here — and why this component
 * provides it in turn, for the filter sidebar it hosts.
 */
import { computed, onMounted, provide } from "vue";
import { Download } from "@lucide/vue";

import CsvGrid from "@/components/editor/CsvGrid.vue";
import InfoTip from "@/components/app/InfoTip.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import PanelTitle from "@/components/app/PanelTitle.vue";
import RunFilterPanel from "./RunFilterPanel.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useResultFrame } from "@/composables/useResultFrame";
import { RESOLUTION_LABELS, SUM_LABELS, keepOne } from "@/lib/chartControls";
import { saveText } from "@/lib/download";
import { csvFilename, frameToCsv } from "@/lib/frameCsv";
import { frameToGrid } from "@/lib/tableRows";
import { useRoundingStore } from "@/stores/rounding";
import {
  RESOLUTIONS,
  RUN_SELECTION,
  SUM_OPTIONS,
  useRunSelection,
  type SumBy,
} from "@/stores/runSelection";

const props = defineProps<{ handle: string }>();

const store = useRunSelection(props.handle);
provide(RUN_SELECTION, store);

const rounding = useRoundingStore();

const table = useResultFrame(
  computed(() => props.handle),
  computed(() => store.tableQuery),
);

// `load` is idempotent, so this costs nothing when the charts have already run
// it — but the table may equally be the first pane anyone opens.
onMounted(() => store.load());

const resolutions = Object.keys(RESOLUTIONS);

const variables = computed(() => store.catalog?.variables.all ?? []);

/**
 * Read-only, and sortable and filterable because a table is for finding things.
 *
 * A cell here is a solved value; making it editable would suggest it could be
 * written back, and there is nowhere for it to go.
 */
const COLUMN_DEFAULTS = { resizable: true, sortable: true, filter: true };

const grid = computed(() =>
  frameToGrid(
    table.frame.value,
    store.techLabels,
    table.unit.value,
    rounding.precision,
  ),
);

const rowCount = computed(() => grid.value.rows.length);
const seriesCount = computed(() => table.frame.value?.series.length ?? 0);

/** Empty and still loading are different things, and read differently. */
const isEmpty = computed(
  () => !table.loading.value && !table.error.value && seriesCount.value === 0,
);

function exportCsv() {
  // Built before anything is awaited: `saveText` opens a file picker, and that
  // needs the click's user gesture still to be live.
  const csv = frameToCsv(
    [{ frame: table.frame.value, unit: table.unit.value }],
    store.techLabels,
    // Not `rounding.precision`: the file stays full-precision unless the user
    // has ticked "apply to downloads".
    rounding.exportPrecision,
  );
  if (!csv) return;
  void saveText(csvFilename(store.catalog?.name, store.variableTable ?? "table"), csv);
}

/** `keepOne` for the sum-by toggle, refusing a locked option. See SUM_OPTIONS. */
function chooseSum(next: unknown): SumBy {
  const value = keepOne(next as SumBy, store.tableSumBy);
  return store.sumLock(store.variableTable, value) ? store.tableSumBy : value;
}

function chooseResolution(next: unknown): string {
  const value = keepOne(next as string, store.tableResolution);
  return store.resampleLock(store.variableTable) ? store.tableResolution : value;
}
</script>

<template>
  <div class="flex min-h-0 flex-1" data-testid="run-table">
    <RunFilterPanel class="w-52 shrink-0" />

    <main class="flex min-h-0 flex-1 flex-col">
      <PanelHeader wrap>
        <PanelTitle>Data</PanelTitle>

        <Select v-model="store.variableTable">
          <SelectTrigger size="sm" class="w-40" data-testid="table-variable">
            <SelectValue placeholder="Variable" />
          </SelectTrigger>
          <SelectContent>
            <!-- Every variable, inputs included: reading a parameter back is
                 half of why anyone opens a table. -->
            <SelectItem v-for="name in variables" :key="name" :value="name">
              {{ name }}
            </SelectItem>
          </SelectContent>
        </Select>

        <!-- Locked rather than hidden on a variable with no timesteps, the same
             rule the sum toggles follow. -->
        <InfoTip :label="store.resampleLock(store.variableTable)">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            data-testid="table-resolution"
            :model-value="store.effectiveTableResolution"
            @update:model-value="
              (value) => (store.tableResolution = chooseResolution(value))
            "
          >
            <ToggleGroupItem
              v-for="name in resolutions"
              :key="name"
              :value="name"
              :aria-disabled="Boolean(store.resampleLock(store.variableTable))"
              :class="
                store.resampleLock(store.variableTable) && 'cursor-default opacity-50'
              "
            >
              {{ RESOLUTION_LABELS[name] ?? name }}
            </ToggleGroupItem>
          </ToggleGroup>
        </InfoTip>

        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          data-testid="table-sum-by"
          :model-value="store.effectiveTableSum"
          @update:model-value="(value) => (store.tableSumBy = chooseSum(value))"
        >
          <InfoTip
            v-for="option in SUM_OPTIONS"
            :key="option"
            :label="store.sumLock(store.variableTable, option)"
          >
            <ToggleGroupItem
              :value="option"
              :aria-disabled="Boolean(store.sumLock(store.variableTable, option))"
              :class="
                store.sumLock(store.variableTable, option) &&
                'cursor-default opacity-50'
              "
            >
              {{ SUM_LABELS[option] }}
            </ToggleGroupItem>
          </InfoTip>
        </ToggleGroup>

        <!-- Columns, not rows: this is the query's `drop_zeros`, which the charts
             use too, so the table stays exactly the frame behind them. A row that
             is blank across every surviving series is saying something true. -->
        <InfoTip
          label="A model defines every variable over the full cross product of its dimensions, so most combinations hold nothing at all."
        >
          <label class="flex items-center gap-1.5 text-2xs text-text-muted">
            <Switch
              v-model="store.tableDropEmpty"
              data-testid="table-drop-empty"
            />
            Hide empty series
          </label>
        </InfoTip>

        <div class="flex-1" />

        <!-- What the table costs, before it is scrolled into. Turning off "hide
             empty" on a real model is what makes this worth showing. -->
        <span
          v-if="seriesCount"
          class="shrink-0 text-2xs text-text-faint"
          data-testid="table-size"
        >
          {{ rowCount.toLocaleString() }} rows × {{ seriesCount.toLocaleString() }}
          series
        </span>

        <TooltipButton
          label="Export this table as CSV"
          :icon="Download"
          size="sm"
          testid="table-download"
          :disabled="!seriesCount"
          @click="exportCsv"
        />
      </PanelHeader>

      <p
        v-if="store.error"
        class="m-2 rounded-sm bg-danger-soft p-2 text-sm text-danger-text"
      >
        {{ store.error }}
      </p>

      <StateMessage
        v-if="table.error.value"
        variant="fill"
        tone="danger"
        class="min-h-0 flex-1"
      >
        {{ table.error.value }}
      </StateMessage>
      <StateMessage
        v-else-if="table.loading.value && !seriesCount"
        variant="fill"
        loading
        class="min-h-0 flex-1"
      >
        Reading results…
      </StateMessage>
      <StateMessage v-else-if="isEmpty" variant="fill" class="min-h-0 flex-1">
        Nothing to show. Widen the filters, or turn off "Hide empty series".
      </StateMessage>

      <CsvGrid
        v-else
        data-testid="table-grid"
        :column-defs="grid.columns"
        :row-data="grid.rows"
        :default-col-def="COLUMN_DEFAULTS"
      />
    </main>
  </div>
</template>
