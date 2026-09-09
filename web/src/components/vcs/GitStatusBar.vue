<script setup lang="ts">
/**
 * The branch and the change count, at the foot of the sidebar.
 *
 * A status bar rather than a nav item: git actions describe the state the
 * folder is in and are read at a glance, where the sidebar's three sections
 * choose what the panel shows. Clicking it opens the changes. Absent, not
 * disabled, on a machine with no git — there is nothing to say.
 */
import { computed } from "vue";

import InfoTip from "@/components/app/InfoTip.vue";
import { TEXT_BUTTON_SM } from "@/lib/formClasses";
import { VcsIcon } from "@/lib/icons";
import { formatCount } from "@/lib/format";
import { useTabsStore } from "@/stores/tabs";
import { useVcsStore } from "@/stores/vcs";

const vcs = useVcsStore();
const tabs = useTabsStore();

const label = computed(() => {
  if (vcs.ready) return vcs.branch ?? "detached";
  if (vcs.state === "ignored") return "ignored by git";
  return "not tracked";
});

const tip = computed(() => {
  if (vcs.ready) {
    const changed = vcs.changedCount
      ? `${formatCount(vcs.changedCount, "file")} changed since the last commit.`
      : "Nothing changed since the last commit.";
    return `On ${label.value}. ${changed} Click to see the changes.`;
  }
  if (vcs.state === "ignored") {
    return `This folder is inside the repository at ${vcs.status?.root}, which ignores it. The Files pane offers to track it separately.`;
  }
  return "This model is not tracked with git. The Files pane offers to track it.";
});
</script>

<template>
  <InfoTip v-if="vcs.available" :label="tip">
    <button
      type="button"
      data-testid="vcs-status"
      :data-state="vcs.state"
      :data-changed="vcs.changedCount"
      :class="TEXT_BUTTON_SM"
      class="inline-flex min-w-0 items-center gap-1"
      :disabled="!vcs.ready"
      @click="tabs.openChanges()"
    >
      <VcsIcon class="size-3 shrink-0" />
      <span class="truncate">{{ label }}</span>
      <span
        v-if="vcs.ready && vcs.changedCount"
        class="tabular-nums text-warning-text"
        data-testid="vcs-status-count"
      >
        {{ vcs.changedCount }}
      </span>
    </button>
  </InfoTip>
</template>
