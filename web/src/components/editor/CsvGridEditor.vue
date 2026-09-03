<script setup lang="ts">
/**
 * A CSV file tab: the grid, a Save button, and the tab's dirty flag.
 *
 * Loading and serialising live in `useCsvGrid`, and the grid itself in
 * `CsvGrid`, because the data-tables view needs both without this component's
 * toolbar. What remains here is only the part that is specific to being a file
 * tab.
 *
 * It stays mounted while it holds edits — `TabBody` renders `csvTabs`, not the
 * active tab — so the cell edits, which live in `useCsvGrid`'s state, survive a
 * look at another tab. And it re-reads the file when something else writes it
 * (a data-table tab saving the same CSV), through the channel every other
 * buffer listens on, but only while it has nothing of its own to lose.
 */
import { computed, onMounted, onUnmounted, ref, toRef, useTemplateRef, watch } from "vue";
import LockedBanner from "@/components/app/LockedBanner.vue";
import StateMessage from "@/components/app/StateMessage.vue";

import CsvGrid from "./CsvGrid.vue";
import EditorToolbar from "./EditorToolbar.vue";
import { errorDetail, isConflict } from "@/api/errors";
import { useCsvGrid } from "@/composables/useCsvGrid";
import { fileTabId } from "@/lib/tabId";
import { useConfirmStore } from "@/stores/confirm";
import { useSectionDataStore } from "@/stores/sectionData";
import { useTabsStore } from "@/stores/tabs";

const props = defineProps<{
  versionId: string | null;
  filePath: string;
}>();

const tabsStore = useTabsStore();
const sectionData = useSectionDataStore();
const confirm = useConfirmStore();

const tabId = computed(() => fileTabId(props.filePath));

/** Another buffer — a data-table tab's grid — holds unsaved changes to this file. */
const locked = computed(() => !tabsStore.canEdit(tabId.value, "csv"));
const lockOwner = computed(() =>
  locked.value ? tabsStore.dirtyOwner(props.filePath) : null,
);

const csv = useCsvGrid(toRef(props, "versionId"), { editable: () => !locked.value });
// Refs are only unwrapped in a template when they are top-level bindings, so the
// ones the template reads are pulled out here rather than reached through `csv`.
const { columnDefs, rowData, isLoading, error, isDirty } = csv;

const csvGrid = useTemplateRef<InstanceType<typeof CsvGrid>>("csvGrid");

onMounted(() => csv.load(props.filePath));

// Edits land in `useCsvGrid` through the grid's valueSetter; this watch only
// propagates its dirtiness to the tab. Both edges: a reload that resets the
// grid must take the dot with it, or the dot lies about edits that no longer
// exist. The tab id is minted from the path — both are strings, so passing
// the bare path would typecheck and silently mark nothing.
watch(isDirty, (dirty) => {
  if (dirty) tabsStore.markDirty(tabId.value, "csv");
  else tabsStore.markClean(tabId.value, "csv");
});

// Something else wrote this file: re-read it, unless the edits here are the
// user's own and would be lost.
let seenRevision = sectionData.fileRevisions.get(props.filePath) ?? 0;
watch(
  () => sectionData.fileRevisions.get(props.filePath) ?? 0,
  (revision) => {
    if (revision === seenRevision) return;
    seenRevision = revision;
    if (!isDirty.value) void csv.load(props.filePath);
  },
);

const isSaving = ref(false);
const saveError = ref<string | null>(null);
const conflict = ref(false);

async function save(): Promise<void> {
  // An open cell editor is an edit, not a draft: commit it before reading.
  csvGrid.value?.commitPendingEdit();
  // A no-op save must not rewrite the file — `serialize_csv` can change quoting
  // on a byte-identical grid.
  if (!isDirty.value) return;
  if (locked.value) {
    saveError.value = `${lockOwner.value?.title ?? "Another tab"} holds unsaved changes to this file.`;
    return;
  }
  isSaving.value = true;
  saveError.value = null;
  conflict.value = false;
  try {
    await csv.save(props.filePath);
    sectionData.noteFileWritten(props.filePath);
    seenRevision = sectionData.fileRevisions.get(props.filePath) ?? 0;
  } catch (caught) {
    conflict.value = isConflict(caught);
    saveError.value = errorDetail(caught, "Failed to save CSV.");
  } finally {
    isSaving.value = false;
  }
}

/** For the 409: the user chooses between their cells and what landed on disk. */
async function reload(): Promise<void> {
  const ok = await confirm.ask({
    title: "Reload this CSV from disk?",
    message: "The unsaved cell edits in this grid will be lost.",
    confirmLabel: "Reload",
    destructive: true,
  });
  if (!ok) return;
  saveError.value = null;
  conflict.value = false;
  csv.markSaved();
  await csv.load(props.filePath);
}

/**
 * Ctrl/Cmd+S, on `window` and gated on this tab being in front.
 *
 * It used to be bound on the container below, so it only answered while focus
 * was inside the grid: click the tab strip, press Cmd+S, and the browser's own
 * Save dialog opened over an unsaved CSV. Every structured editor listens this
 * way (`useSectionEditor`), and a CSV tab has no reason to be the exception —
 * the gate is what keeps one keystroke from saving every mounted grid, since a
 * dirty one stays mounted while another tab is looked at.
 *
 * `save` commits the open cell editor and reports its own failures, so the
 * promise can be discarded.
 */
function onKeyDown(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.key !== "s") return;
  if (tabsStore.activeId !== tabId.value) return;
  e.preventDefault();
  void save();
}

onMounted(() => window.addEventListener("keydown", onKeyDown));
onUnmounted(() => window.removeEventListener("keydown", onKeyDown));
</script>

<template>
  <!-- design-check: allow focus — a focus *container*, not a control: it takes
       focus so the grid can receive keys, and a ring round a whole pane says nothing. -->
  <div class="flex min-h-0 flex-1 flex-col outline-none" tabindex="-1">
    <StateMessage v-if="isLoading" variant="block" loading>Loading…</StateMessage>
    <StateMessage v-else-if="error" variant="block" tone="danger">{{ error }}</StateMessage>

    <template v-else>
      <EditorToolbar
        :file="filePath"
        :saving="isSaving"
        :disabled="locked"
        :error="saveError"
        :conflict="conflict"
        @save="save"
        @reload="reload"
      />
      <LockedBanner v-if="lockOwner" :owner="lockOwner" :file="filePath" />
      <CsvGrid ref="csvGrid" :column-defs="columnDefs" :row-data="rowData" />
    </template>
  </div>
</template>
