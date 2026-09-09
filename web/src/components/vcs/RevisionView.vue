<script setup lang="ts">
/**
 * What differs from the last commit, or what one commit changed — a file
 * list beside a diff, with a commit box under the first.
 *
 * One component for both tabs because they are one view with one thing
 * swapped: the changes tab lists the working tree against HEAD and ends in a
 * message box; the commit tab lists one commit against its parent and is
 * read-only. The diff pane is the compare view's own — two whole texts in
 * Monaco's diff editor, transient models, both sides forced to LF.
 *
 * Deliberately not the compare view's file list. That one answers "what do
 * these two versions of the model refer to", scoped so a scratch file beside
 * the model is not reported as newly added; git answers "what differs from
 * HEAD in this folder", untracked files included. A YAML file the user has
 * created but not yet imported is a real uncommitted change and a non-entity
 * to compare.
 */
import { computed, ref, watch } from "vue";

import { errorDetail } from "@/api/errors";
import { getVcsDiff, type VcsCommitFile, type VcsDiff } from "@/api/vcs";
import PanelHeader from "@/components/app/PanelHeader.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import DiffPane from "@/components/editor/DiffPane.vue";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { GitCompare } from "@lucide/vue";
import { commitRef, workspaceRef } from "@/lib/compareRef";
import { FIELD, IDENTIFIER, PRIMARY_BUTTON } from "@/lib/formClasses";
import { formatCount, formatTimestamp } from "@/lib/format";
import { useConfirmStore } from "@/stores/confirm";
import { useTabsStore, type RevisionTab } from "@/stores/tabs";
import { useUiStore } from "@/stores/ui";
import { useVcsStore, type VcsCommitDetail } from "@/stores/vcs";

import ChangeList from "./ChangeList.vue";

const props = defineProps<{ tab: RevisionTab }>();

const tabs = useTabsStore();
const ui = useUiStore();
const vcs = useVcsStore();

const isChanges = computed(() => props.tab.kind === "changes");
const sha = computed(() => (props.tab.kind === "commit" ? props.tab.sha : null));

// -- the commit, for a commit tab --------------------------------------------

const detail = ref<VcsCommitDetail | null>(null);
const detailError = ref<string | null>(null);

watch(
  sha,
  async (wanted) => {
    detail.value = null;
    detailError.value = null;
    if (!wanted) return;
    try {
      const found = await vcs.commitDetail(wanted);
      if (sha.value === wanted) detail.value = found;
    } catch (caught) {
      if (sha.value === wanted) {
        // A `commit:{sha}` restored after the commit is gone — rewritten
        // history, or another model's tab set — degrades to this, not a 404.
        detailError.value = errorDetail(caught, "This commit is not in the repository.");
      }
    }
  },
  { immediate: true },
);

const files = computed<VcsCommitFile[]>(() =>
  isChanges.value ? vcs.changes : (detail.value?.files ?? []),
);

/**
 * Opens on the first file rather than on nothing, and again when the
 * selection names a file the list no longer holds — which a commit or a
 * discard does to the changes tab.
 */
watch(
  files,
  (list) => {
    const current = props.tab.selectedPath;
    if (current && list.some((file) => file.path === current)) return;
    tabs.setRevisionSelection(props.tab.id, list[0]?.path ?? null);
  },
  { immediate: true },
);

// -- the diff ----------------------------------------------------------------

const diff = ref<VcsDiff | null>(null);
const fileError = ref<string | null>(null);

/** Which request owns `diff`; an older answer must not land under a newer path. */
let generation = 0;

watch(
  // `vcs.changes` is replaced on every refresh, so a save re-reads the diff.
  () => [props.tab.selectedPath, sha.value, vcs.changes] as const,
  async ([path, wanted]) => {
    const mine = ++generation;
    fileError.value = null;
    if (!path || !tabs.versionId) {
      diff.value = null;
      return;
    }
    try {
      const fetched = await getVcsDiff(tabs.versionId, path, wanted);
      if (mine === generation) diff.value = fetched;
    } catch (caught) {
      if (mine === generation) {
        diff.value = null;
        fileError.value = errorDetail(caught, `Could not read ${path}.`);
      }
    }
  },
  { immediate: true },
);

const selected = computed(() =>
  files.value.find((file) => file.path === props.tab.selectedPath),
);

// -- committing --------------------------------------------------------------

const message = ref("");
const commitError = ref<string | null>(null);

const canCommit = computed(
  () => isChanges.value && vcs.changedCount > 0 && message.value.trim().length > 0 && !vcs.busy,
);

async function commit() {
  if (!canCommit.value) return;
  commitError.value = null;
  try {
    await vcs.commit(message.value.trim());
    message.value = "";
  } catch (caught) {
    commitError.value = errorDetail(caught, "The commit could not be made.");
  }
}

async function discard(path: string) {
  const ok = await useConfirmStore().ask({
    title: `Discard the changes to ${path}?`,
    message: "The file goes back to how the last commit has it. This cannot be undone.",
    confirmLabel: "Discard",
    destructive: true,
  });
  if (!ok) return;
  commitError.value = null;
  try {
    await vcs.discard(path);
  } catch (caught) {
    commitError.value = errorDetail(caught, "The changes could not be discarded.");
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="revision-view" :data-kind="tab.kind">
    <!-- A commit's identity, where the compare tab shows its two sides. -->
    <PanelHeader v-if="!isChanges" size="md" tone="surface" data-testid="commit-header">
      <span v-if="detail" class="min-w-0 truncate text-sm">{{ detail.commit.subject }}</span>
      <span v-else-if="detailError" class="text-sm text-danger-text">{{ detailError }}</span>
      <span v-else class="text-sm text-text-muted">Reading the commit…</span>
      <div class="flex-1" />
      <template v-if="detail">
        <span :class="IDENTIFIER" class="tabular-nums" data-testid="commit-sha">
          {{ detail.commit.short }}
        </span>
        <span class="shrink-0 text-2xs text-text-muted">
          {{ detail.commit.author }} · {{ formatTimestamp(detail.commit.date) }}
        </span>
        <!-- The compare view's Model half, on history: what this commit did
             to the resolved model, not only to its text. -->
        <TooltipButton
          label="Compare the model at this commit with the current model."
          :icon="GitCompare"
          size="xs"
          testid="commit-compare"
          @click="tabs.openCompare(commitRef(detail.commit.sha), workspaceRef())"
        />
      </template>
    </PanelHeader>

    <p
      v-if="detail?.commit.body"
      class="shrink-0 whitespace-pre-line border-b border-border-subtle px-2 py-1 text-sm text-text-dim"
      data-testid="commit-body"
    >
      {{ detail.commit.body }}
    </p>

    <StateMessage
      v-if="isChanges && !vcs.ready"
      variant="fill"
      data-testid="revision-untracked"
    >
      This model is not tracked with git. The Files pane offers to track it.
    </StateMessage>
    <StateMessage
      v-else-if="isChanges && !files.length"
      variant="fill"
      title="Nothing to commit"
      data-testid="revision-empty"
    >
      Every file is as the last commit has it.
    </StateMessage>
    <StateMessage v-else-if="!isChanges && detailError" variant="fill" tone="danger">
      {{ detailError }}
    </StateMessage>
    <StateMessage v-else-if="!isChanges && !detail" variant="fill" loading>
      Reading the commit…
    </StateMessage>

    <ResizablePanelGroup
      v-else
      direction="horizontal"
      class="min-h-0 flex-1"
      @layout="ui.setRevisionSplit($event)"
    >
      <ResizablePanel :default-size="ui.revisionSplit[0]" :min-size="15">
        <div class="h-full overflow-auto">
          <ChangeList
            :files="files"
            :selected-path="tab.selectedPath"
            :discardable="isChanges"
            :disabled="vcs.busy"
            @select="tabs.setRevisionSelection(tab.id, $event)"
            @discard="discard"
          />
        </div>
      </ResizablePanel>

      <ResizableHandle with-handle />

      <ResizablePanel :default-size="ui.revisionSplit[1]" :min-size="30">
        <div class="relative h-full">
          <StateMessage v-if="fileError" variant="fill" tone="danger">
            {{ fileError }}
          </StateMessage>
          <StateMessage v-else-if="!tab.selectedPath" variant="fill">
            Choose a file to see what changed in it.
          </StateMessage>
          <StateMessage
            v-else-if="diff?.binary"
            variant="fill"
            title="This file is not text"
            data-testid="revision-binary"
          >
            It changed, but there is nothing to show side by side.
          </StateMessage>
          <StateMessage
            v-else-if="diff?.truncated"
            variant="fill"
            title="This file is too large to show"
          >
            It changed, but a diff of it would not fit in the browser.
          </StateMessage>
          <DiffPane
            v-else-if="diff"
            :path="tab.selectedPath"
            :original="diff.original"
            :modified="diff.modified"
          />
          <StateMessage v-else variant="fill" loading>
            Reading {{ tab.selectedPath }}…
          </StateMessage>

          <!-- Which side lacks the file is the whole content of an addition
               or a deletion, and an empty pane does not say it. -->
          <p
            v-if="diff && !diff.binary && !diff.truncated && (!diff.original_exists || !diff.modified_exists)"
            class="pointer-events-none absolute inset-x-0 top-1 z-raised text-center text-2xs text-text-muted"
            data-testid="revision-one-sided"
          >
            {{ diff.original_exists ? "Deleted" : selected?.state === "untracked" ? "Not yet tracked" : "Added" }}
          </p>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>

    <!-- The commit box, under the changes only: a commit is read, not made. -->
    <div
      v-if="isChanges && vcs.ready"
      class="flex shrink-0 items-center gap-1.5 border-t border-border p-2"
      data-testid="commit-box"
    >
      <input
        v-model="message"
        type="text"
        aria-label="Commit message"
        placeholder="What changed, and why"
        data-testid="commit-message"
        :class="FIELD"
        :disabled="!vcs.changedCount || vcs.busy"
        @keydown.enter="commit"
      />
      <button
        type="button"
        data-testid="commit-button"
        :class="PRIMARY_BUTTON"
        class="shrink-0"
        :disabled="!canCommit"
        @click="commit"
      >
        Commit {{ formatCount(vcs.changedCount, "file") }}
      </button>
    </div>
    <StateMessage v-if="commitError" variant="inline" tone="danger" data-testid="commit-error">
      {{ commitError }}
    </StateMessage>
  </div>
</template>
