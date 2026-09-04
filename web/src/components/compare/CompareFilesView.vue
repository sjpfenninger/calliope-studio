<script setup lang="ts">
/**
 * What differs between two versions of the model, file by file.
 *
 * The list is flat rather than a tree. A changed file is what somebody is
 * looking for, and a tree buries three of them under six folders that exist
 * only to hold them — and this is the shape the version-tracking work wants for
 * its own Changes list, so it is worth being one thing.
 */
import { computed, ref, watch } from "vue";

import type { CompareFiles, FileChange, FilePair } from "@/api/compare";
import StateMessage from "@/components/app/StateMessage.vue";
import DiffPane from "@/components/editor/DiffPane.vue";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { CompareRef } from "@/lib/compareRef";
import { formatBytes, formatCount } from "@/lib/format";
import { TEXT_BUTTON_SM } from "@/lib/formClasses";
import { useCompareStore } from "@/stores/compare";
import { useUiStore } from "@/stores/ui";

const props = defineProps<{
  versionId: string;
  a: CompareRef;
  b: CompareRef;
  payload: CompareFiles | null;
  loading: boolean;
  error: string | null;
  selectedPath: string | null;
}>();

const emit = defineEmits<{ select: [string | null] }>();

const ui = useUiStore();
const compare = useCompareStore();

const showUnchanged = ref(false);
const pair = ref<FilePair | null>(null);
const fileError = ref<string | null>(null);

const changed = computed(() =>
  (props.payload?.files ?? []).filter((file) => file.status !== "unchanged"),
);
const unchangedCount = computed(
  () => (props.payload?.files.length ?? 0) - changed.value.length,
);
const shown = computed(() =>
  showUnchanged.value ? (props.payload?.files ?? []) : changed.value,
);

/** M, A, D — and a tone that says which without the letter being read. */
const MARK: Record<FileChange["status"], { letter: string; tone: string }> = {
  modified: { letter: "M", tone: "text-warning-text" },
  added: { letter: "A", tone: "text-success-text" },
  removed: { letter: "D", tone: "text-danger-text" },
  unchanged: { letter: "·", tone: "text-text-faint" },
};

/**
 * Both sides read the same folder, so the files cannot differ.
 *
 * Worth its own words: an empty list under two *different* versions means
 * nothing changed, and under one folder read with two scenarios it means the
 * question was never about the files. One message for both would read as the
 * comparison having failed to run.
 */
const sameRoot = computed(() => props.payload?.same_root === true);

const selected = computed(() =>
  (props.payload?.files ?? []).find((file) => file.path === props.selectedPath),
);

/** Opens on the first thing worth looking at, rather than on nothing. */
watch(
  () => props.payload,
  (payload) => {
    if (!payload || props.selectedPath) return;
    const first = changed.value[0] ?? payload.files[0];
    if (first) emit("select", first.path);
  },
  { immediate: true },
);

watch(
  () => [props.selectedPath, props.a, props.b] as const,
  async ([path]) => {
    pair.value = null;
    fileError.value = null;
    if (!path) return;
    try {
      pair.value = await compare.file(props.versionId, props.a, props.b, path);
    } catch {
      fileError.value = `Could not read ${path}.`;
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="compare-files">
    <StateMessage v-if="error" variant="fill" tone="danger">{{ error }}</StateMessage>
    <StateMessage v-else-if="loading && !payload" variant="fill" loading>
      Comparing the two versions…
    </StateMessage>
    <StateMessage
      v-else-if="payload?.identical"
      variant="fill"
      data-testid="compare-files-empty"
      :title="sameRoot ? 'Both sides read the same files' : 'No differences'"
    >
      {{
        sameRoot
          ? "The two sides are one model definition, so only their scenarios differ. The Model view shows what that changes."
          : "These two versions of the model are written exactly the same way."
      }}
    </StateMessage>

    <ResizablePanelGroup
      v-else
      direction="horizontal"
      class="min-h-0 flex-1"
      @layout="ui.setCompareSplit($event)"
    >
      <ResizablePanel :default-size="ui.compareSplit[0]" :min-size="15">
        <div class="h-full overflow-auto">
          <button
            v-for="file in shown"
            :key="file.path"
            type="button"
            class="flex w-full items-center gap-1.5 border-b border-border-subtle px-2 py-1 text-left hover:bg-hover"
            :class="file.path === selectedPath && 'bg-accent-soft text-accent-text'"
            data-testid="compare-file"
            :data-path="file.path"
            :data-status="file.status"
            @click="emit('select', file.path)"
          >
            <span
              class="w-3 shrink-0 text-center text-2xs"
              :class="MARK[file.status].tone"
              >{{ MARK[file.status].letter }}</span
            >
            <span class="min-w-0 flex-1 truncate text-sm">{{ file.path }}</span>
            <span class="shrink-0 text-2xs text-text-muted">
              {{ formatBytes((file.b ?? file.a)?.size ?? 0) }}
            </span>
          </button>

          <button
            v-if="unchangedCount > 0"
            type="button"
            :class="TEXT_BUTTON_SM"
            class="m-2"
            data-testid="compare-show-unchanged"
            @click="showUnchanged = !showUnchanged"
          >
            {{
              showUnchanged
                ? "Hide unchanged"
                : `Show ${formatCount(unchangedCount, "unchanged file")}`
            }}
          </button>
        </div>
      </ResizablePanel>

      <ResizableHandle with-handle />

      <ResizablePanel :default-size="ui.compareSplit[1]" :min-size="30">
        <div class="relative h-full">
          <StateMessage v-if="fileError" variant="fill" tone="danger">
            {{ fileError }}
          </StateMessage>
          <StateMessage v-else-if="!selectedPath" variant="fill">
            Choose a file to see what changed in it.
          </StateMessage>
          <StateMessage
            v-else-if="pair?.binary"
            variant="fill"
            data-testid="compare-binary"
            title="This file is not text"
          >
            It differs between the two versions, but there is nothing to show
            side by side.
          </StateMessage>
          <DiffPane
            v-else-if="pair"
            :path="selectedPath"
            :original="pair.a?.content ?? ''"
            :modified="pair.b?.content ?? ''"
          />
          <StateMessage v-else variant="fill" loading>
            Reading {{ selectedPath }}…
          </StateMessage>

          <!-- Which side lacks the file is the whole content of an addition or
               a deletion, and an empty pane does not say it. -->
          <p
            v-if="pair && !pair.binary && (!pair.a || !pair.b)"
            class="pointer-events-none absolute inset-x-0 top-1 z-raised text-center text-2xs text-text-muted"
            data-testid="compare-one-sided"
          >
            {{ selected?.status === "added" ? "Added" : "Removed" }} in this version
          </p>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  </div>
</template>
