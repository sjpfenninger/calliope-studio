<script setup lang="ts">
/**
 * Commits, newest first: the subject, and who made it when.
 *
 * Two lines and always two, the rule `RunListItem` states: the list is read by
 * scanning down it, and a row that stands taller than its neighbours reads as
 * a different kind of thing.
 */
import InfoTip from "@/components/app/InfoTip.vue";
import type { VcsCommit } from "@/api/vcs";
import { formatRelativeTime, formatTimestamp } from "@/lib/format";

const props = withDefaults(
  defineProps<{ commits: VcsCommit[]; selectedSha?: string | null }>(),
  { selectedSha: null },
);

const emit = defineEmits<{ select: [commit: VcsCommit] }>();
</script>

<template>
  <div>
    <button
      v-for="commit in props.commits"
      :key="commit.sha"
      type="button"
      class="flex w-full flex-col gap-0.5 border-b border-border-subtle px-2 py-1 text-left hover:bg-hover"
      :class="commit.sha === props.selectedSha && 'bg-accent-soft text-accent-text'"
      data-testid="vcs-commit"
      :data-sha="commit.sha"
      @click="emit('select', commit)"
    >
      <span class="truncate text-sm">{{ commit.subject }}</span>
      <span class="flex items-center gap-1.5 text-2xs text-text-dim">
        <span class="tabular-nums">{{ commit.short }}</span>
        <span class="truncate">{{ commit.author }}</span>
        <InfoTip :label="formatTimestamp(commit.date)">
          <span class="ml-auto shrink-0">{{ formatRelativeTime(commit.date) }}</span>
        </InfoTip>
      </span>
    </button>
  </div>
</template>
