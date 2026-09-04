<script setup lang="ts">
/**
 * The model definition this run was solved from.
 *
 * Two views, because they answer two different questions and neither subsumes
 * the other:
 *
 * - **As written** is the YAML and CSV frozen into the run directory before the
 *   worker existed. It is what the user wrote, comments and all, and since the
 *   worker now solves *from* this tree it is provably the thing that was solved.
 * - **As solved** is the resolved configuration read back out of `results.nc` —
 *   every default filled in, every override applied. It is what Calliope
 *   actually used, which is rarely what the file says.
 *
 * Read-only throughout: history is not editable. That is also why this does not
 * reuse the Monaco instance the editor owns — a shared editor with a read-only
 * flag is one mistake away from a frozen file becoming writable, and the
 * highlighting is not worth that.
 */
import { computed, ref, watch } from "vue";
import Segmented from "@/components/app/Segmented.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import InfoTip from "@/components/app/InfoTip.vue";
import Eyebrow from "@/components/app/Eyebrow.vue";
import { FileWarning } from "@lucide/vue";

import { Badge } from "@/components/ui/badge";
import { Tree } from "@/components/ui/tree";
import { errorDetail } from "@/api/errors";
import { getSnapshot, getSnapshotCsv, getSnapshotFile, listSnapshotFiles } from "@/api/runs";
import { fetchSummary } from "@/api/results";
import { buildFileTree, type FileEntry, type FileTreeNode } from "@/lib/fileTree";
import { formatBytes, formatCount } from "@/lib/format";
import { fileIcon } from "@/lib/icons";
import { CODE_BLOCK, FIELD_WIDTH, WARNING_BADGE } from "@/lib/formClasses";

const props = defineProps<{ runId: string; handle: string | null }>();

/** What the snapshot captured, and what it could not. */
interface Manifest {
  available: boolean;
  reason: string | null;
  complete?: boolean;
  solve_from?: string;
  files?: FileEntry[];
  /** What the snapshot could *not* capture, and why. */
  external?: Array<{ reference: string; referenced_by: string; reason: string }>;
}

interface Summary {
  model: Record<string, unknown>;
  init_config: Record<string, unknown>;
  build_config: Record<string, unknown>;
  solve_config: Record<string, unknown>;
}

type View = "written" | "solved";

const view = ref<View>("written");
const manifest = ref<Manifest | null>(null);
const tree = ref<FileTreeNode[]>([]);
const selected = ref<FileTreeNode>();
const content = ref<string | null>(null);
const csv = ref<{ columns: Array<{ name: string }>; rows: unknown[][] } | null>(null);
const summary = ref<Summary | null>(null);
const summaryError = ref<string | null>(null);
/**
 * What went wrong reading the frozen tree.
 *
 * Every fetch below is awaited inside a watcher, and a watcher holds no
 * rejection — so a run whose snapshot is missing, or a file the server refuses,
 * produced an unhandled rejection and a pane that was simply empty, with
 * nothing anywhere to say the request had failed at all.
 */
const error = ref<string | null>(null);
/** The same, for one file: shown in the content pane, so the tree survives it. */
const fileError = ref<string | null>(null);

const external = computed(() => manifest.value?.external ?? []);

watch(
  () => props.runId,
  async (runId) => {
    error.value = null;
    try {
      manifest.value = await getSnapshot<Manifest>(runId);
      if (!manifest.value?.available) return;

      const files = await listSnapshotFiles(runId);
      tree.value = buildFileTree(files);
      // Opening on the model's entry point rather than on nothing: it is the
      // file anyone reading a frozen configuration starts from.
      const entry = files.find((file) => file.path === "model.yaml") ?? files[0];
      if (entry) await show(entry.path, entry.type);

    } catch (caught) {
      error.value = errorDetail(caught, "Could not read this run's snapshot.");
    }
  },
  { immediate: true },
);

// Fetched lazily: it means loading the whole solved model server-side, which is
// not worth doing for someone who only wanted to see the YAML.
watch([view, () => props.handle], async ([current, handle]) => {
  if (current !== "solved" || !handle || summary.value) return;
  try {
    summary.value = await fetchSummary(handle);
    summaryError.value = null;
  } catch (caught) {
    summaryError.value = errorDetail(caught, "Could not read the solved model.");
  }
});

watch(selected, (node) => {
  if (node?.leaf) void show(node.key, node.type);
});

async function show(path: string, type: string) {
  content.value = null;
  csv.value = null;
  fileError.value = null;
  try {
    if (type === "csv") {
      csv.value = await getSnapshotCsv(props.runId, path);
    } else {
      content.value = await getSnapshotFile(props.runId, path);
    }
  } catch (caught) {
    fileError.value = errorDetail(caught, `Could not read ${path}.`);
  }
}

/** Config blocks render as flat rows; nested values are shown as JSON. */
function display(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const SECTIONS: Array<{ key: keyof Summary; label: string }> = [
  { key: "model", label: "Model" },
  { key: "init_config", label: "config.init" },
  { key: "build_config", label: "config.build" },
  { key: "solve_config", label: "config.solve" },
];

/** The two views, as segments. */
const viewSegments = computed(() => [
  { value: "written" as View, label: "As written", testid: "config-view-written" },
  {
    value: "solved" as View,
    label: "As solved",
    disabled: !props.handle,
    tip: props.handle ? undefined : "This run has no solved model to read",
    testid: "config-view-solved",
  },
]);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="run-config">
    <PanelHeader size="md">
      <!-- These swap the whole body below, so under the one selection rule they
           navigate: an accent bar, not the `bg-active` fill they used to carry.

           `size="fill"`, not a named height: a 28px strip has a 27px content box
           once its `border-b` is counted, so an h-7 segment overflowed it by a
           pixel and `items-center` split that — half over the hairline above and
           half over the one below. `SEGMENT_SIZE.fill` measures the box instead,
           which is what ResultsLayoutBar already did and this did not. -->
      <Segmented v-model="view" :items="viewSegments" mode="nav" seam="none" size="fill" />

      <div class="flex-1" />

      <!-- A model reaching outside its own folder cannot be fully frozen, and
           such a run falls back to solving the live workspace. Saying so here is
           the only place the user finds out. -->
      <!-- One line per file, which is what `InfoTip`'s `whitespace-pre-line` is
           for: a native `title` renders `\n` differently on every platform. -->
      <InfoTip
        v-if="manifest?.complete === false"
        :label="
          external.map((entry) => `${entry.reference} — ${entry.reason}`).join('\n')
        "
      >
        <Badge variant="outline" :class="WARNING_BADGE">
          <FileWarning />
          {{ formatCount(external.length, "file") }} outside the model folder
        </Badge>
      </InfoTip>
    </PanelHeader>

    <StateMessage v-if="error" variant="inline" tone="danger">
      {{ error }}
    </StateMessage>

    <StateMessage v-else-if="manifest && !manifest.available" variant="inline">
      {{ manifest.reason }}
    </StateMessage>

    <div v-else-if="view === 'written'" class="flex min-h-0 flex-1">
      <Tree
        v-model="selected"
        :items="tree"
        :get-key="(node) => (node as FileTreeNode).key"
        :get-children="(node) => (node as FileTreeNode).children"
        :get-label="(node) => (node as FileTreeNode).label"
        :get-icon="
          (node) =>
            fileIcon(
              (node as FileTreeNode).leaf
                ? ((node as FileTreeNode).type ?? '')
                : 'directory',
            )
        "
        data-testid="snapshot-tree"
        class="w-56 shrink-0 border-r border-border bg-panel"
      >
        <template #trailing="{ item }">
          <span
            v-if="(item as FileTreeNode).size !== undefined"
            class="ml-auto shrink-0 text-2xs tabular-nums text-text-muted"
          >
            {{ formatBytes((item as FileTreeNode).size ?? 0) }}
          </span>
        </template>
      </Tree>

      <div class="min-h-0 flex-1 overflow-auto bg-surface">
        <StateMessage v-if="fileError" variant="inline" tone="danger">
          {{ fileError }}
        </StateMessage>

        <pre
          v-else-if="content !== null"
          data-testid="snapshot-content"
          class="p-2 whitespace-pre"
          :class="CODE_BLOCK"
          >{{ content }}</pre
        >

        <!-- Row heights match AG Grid's `--cg-row-h`: the same CSV opens in a
             grid one tab away, and a table of the same file at two rhythms
             reads as two different files. -->
        <!-- Its own testid: it is a sibling of the text pane rather than
             inside it, so `snapshot-content` cannot reach it. -->
        <table v-else-if="csv" data-testid="snapshot-csv" class="w-full text-sm">
          <thead class="sticky top-0 bg-panel">
            <tr>
              <th
                v-for="column in csv.columns"
                :key="column.name"
                class="border-b border-border px-2 py-1.5 text-left font-medium"
              >
                {{ column.name }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in csv.rows" :key="index">
              <td
                v-for="(cell, cellIndex) in row"
                :key="cellIndex"
                class="border-b border-border-subtle px-2 py-1 tabular-nums"
              >
                {{ cell }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-auto p-2" data-testid="run-summary">
      <StateMessage v-if="summaryError" variant="inline" tone="danger">
        {{ summaryError }}
      </StateMessage>
      <StateMessage v-else-if="!summary" variant="inline" loading>Reading results…</StateMessage>

      <template v-else>
        <section v-for="section in SECTIONS" :key="section.key" class="mb-3">
          <Eyebrow class="mb-1">
            {{ section.label }}
          </Eyebrow>
          <dl class="rounded-md border border-border">
            <div
              v-for="(value, key) in summary[section.key]"
              :key="key"
              class="flex gap-2 border-b border-border-subtle px-2 py-1 text-sm last:border-b-0"
            >
              <dt :class="[FIELD_WIDTH.wide, 'truncate text-text-dim']">{{ key }}</dt>
              <!-- design-check: allow native-title — the same string the `dd`
                   prints, unclipped. -->
              <dd class="min-w-0 flex-1 truncate" :title="display(value)">
                {{ display(value) }}
              </dd>
            </div>
          </dl>
        </section>
      </template>
    </div>
  </div>
</template>
