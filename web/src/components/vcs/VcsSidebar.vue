<script setup lang="ts">
/**
 * Changes and History, under the file tree.
 *
 * Two disclosures rather than a fourth section: what has changed is a fact
 * about the files, and going to Files is what you do about a change. The
 * three states in which git has nothing to list each say why, and the two
 * that can be fixed from here offer the fix — a folder in no repository, and
 * one inside a repository that ignores it, which is the state `pixi run
 * serve` opens and would otherwise read as a healthy, empty history.
 */
import { computed, ref } from "vue";
import { GitCommitHorizontal, RefreshCw } from "@lucide/vue";

import PanelDisclosure from "@/components/app/PanelDisclosure.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import { Badge } from "@/components/ui/badge";
import { errorDetail } from "@/api/errors";
import { IDENTIFIER, NEUTRAL_BADGE, SECONDARY_BUTTON, WARNING_BADGE } from "@/lib/formClasses";
import { useConfirmStore } from "@/stores/confirm";
import { useTabsStore } from "@/stores/tabs";
import { useVcsStore, type VcsCommit } from "@/stores/vcs";
import { useVersionStore } from "@/stores/version";

import ChangeList from "./ChangeList.vue";
import CommitList from "./CommitList.vue";
import TrackWithGitDialog from "./TrackWithGitDialog.vue";

const vcs = useVcsStore();
const tabs = useTabsStore();
const version = useVersionStore();

const tracking = ref(false);

/** Why the last action failed. One surface, as `RunsSection` has. */
const actionError = ref<string | null>(null);

const fileCount = computed(
  () => version.files.filter((entry) => entry.type !== "directory").length,
);

/**
 * Through the one confirm dialog: this is the only destructive action in the
 * feature, and the file's edits are its only copy of them.
 */
async function discard(path: string) {
  const ok = await useConfirmStore().ask({
    title: `Discard the changes to ${path}?`,
    message: "The file goes back to how the last commit has it. This cannot be undone.",
    confirmLabel: "Discard",
    destructive: true,
  });
  if (!ok) return;
  actionError.value = null;
  try {
    await vcs.discard(path);
  } catch (caught) {
    actionError.value = errorDetail(caught, "The changes could not be discarded.");
  }
}

function openCommit(commit: VcsCommit) {
  tabs.openCommit(commit.sha, commit.subject);
}
</script>

<template>
  <!-- Capped at half the sidebar's body, and the lists shrink and scroll inside
       the cap: a fixed height per list would ignore the window and the tree
       above would be squeezed by two empty boxes. -->
  <div
    v-if="vcs.available"
    class="flex max-h-1/2 shrink-0 flex-col border-t border-border"
    data-testid="vcs-panels"
  >
    <!-- A nested 28px strip holding 20px controls: one size below, the rule
         every other strip follows. -->
    <PanelHeader size="md">
      <PanelDisclosure
        :open="vcs.changesOpen"
        label="Changes"
        testid="vcs-changes-toggle"
        @toggle="vcs.changesOpen = !vcs.changesOpen"
      >
        Changes
      </PanelDisclosure>
      <Badge
        v-if="vcs.ready"
        variant="outline"
        :class="vcs.changedCount ? WARNING_BADGE : NEUTRAL_BADGE"
        data-testid="vcs-changes-count"
      >
        {{ vcs.changedCount }}
      </Badge>
      <div class="flex-1" />
      <TooltipButton
        v-if="vcs.ready && vcs.changedCount"
        size="xs"
        :icon="GitCommitHorizontal"
        label="Read the changes and commit them"
        testid="vcs-open-changes"
        @click="tabs.openChanges()"
      />
      <TooltipButton
        v-if="vcs.ready"
        size="xs"
        :icon="RefreshCw"
        label="Re-read the repository"
        testid="vcs-refresh"
        @click="vcs.refresh()"
      />
    </PanelHeader>

    <div v-show="vcs.changesOpen" class="min-h-0 overflow-auto" data-testid="vcs-changes">
      <StateMessage v-if="vcs.error" variant="inline" tone="danger">
        {{ vcs.error }}
      </StateMessage>
      <StateMessage v-else-if="actionError" variant="inline" tone="danger">
        {{ actionError }}
      </StateMessage>

      <StateMessage v-if="vcs.state === 'untracked'" variant="inline" class="flex-wrap">
        This model is not tracked with git.
        <template #action>
          <button
            type="button"
            :class="SECONDARY_BUTTON"
            data-testid="vcs-track"
            @click="tracking = true"
          >
            Track with git…
          </button>
        </template>
      </StateMessage>

      <StateMessage v-else-if="vcs.state === 'ignored'" variant="inline" class="flex-wrap">
        <span>
          Inside the repository at
          <code :class="IDENTIFIER">{{ vcs.status?.root }}</code>, which ignores this
          folder.
        </span>
        <template #action>
          <button
            type="button"
            :class="SECONDARY_BUTTON"
            data-testid="vcs-track"
            @click="tracking = true"
          >
            Track separately…
          </button>
        </template>
      </StateMessage>

      <StateMessage
        v-else-if="vcs.ready && !vcs.changedCount && !vcs.loading"
        variant="inline"
        data-testid="vcs-changes-empty"
      >
        Nothing changed since the last commit.
      </StateMessage>

      <ChangeList
        v-else-if="vcs.ready"
        :files="vcs.changes"
        discardable
        :disabled="vcs.busy"
        @select="tabs.openChanges($event)"
        @discard="discard"
      />
    </div>

    <template v-if="vcs.ready">
      <PanelHeader size="md">
        <PanelDisclosure
          :open="vcs.historyOpen"
          label="History"
          testid="vcs-history-toggle"
          @toggle="vcs.historyOpen = !vcs.historyOpen"
        >
          History
        </PanelDisclosure>
      </PanelHeader>
      <div v-show="vcs.historyOpen" class="min-h-0 overflow-auto" data-testid="vcs-history">
        <StateMessage v-if="!vcs.log.length" variant="inline">No commits yet.</StateMessage>
        <CommitList v-else :commits="vcs.log" @select="openCommit" />
      </div>
    </template>

    <TrackWithGitDialog v-model:open="tracking" :file-count="fileCount" />
  </div>
</template>
