<script setup lang="ts">
/**
 * Changed files, one per row: a letter for the state, the path, and — where
 * the caller allows it — a way to throw the change away.
 *
 * Flat rather than a tree, for the reason `CompareFilesView` gives: a
 * changed file is what somebody is looking for, and a tree buries three of
 * them under six folders that exist only to hold them. Shared by the sidebar
 * disclosure and the changes tab, so the two cannot mark a file differently.
 *
 * The row is a `div` with the path as its button and the discard beside it,
 * rather than one button holding another: nested interactive elements are
 * invalid markup, and a screen reader reads them as one control.
 */
import { Undo2 } from "@lucide/vue";

import InfoTip from "@/components/app/InfoTip.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import type { VcsCommitFile } from "@/api/vcs";
import { MARK } from "@/lib/vcsStatus";

const props = withDefaults(
  defineProps<{
    files: VcsCommitFile[];
    selectedPath?: string | null;
    /** Offer to discard each row's change. Only the working tree can. */
    discardable?: boolean;
    disabled?: boolean;
  }>(),
  { selectedPath: null, discardable: false, disabled: false },
);

const emit = defineEmits<{ select: [path: string]; discard: [path: string] }>();

function describe(file: VcsCommitFile): string {
  if (file.state === "renamed" && file.original) return `Renamed from ${file.original}`;
  return MARK[file.state].label;
}

function discard(event: MouseEvent, path: string) {
  // The row opens on click; the discard must not also open it.
  event.stopPropagation();
  emit("discard", path);
}
</script>

<template>
  <div>
    <div
      v-for="file in props.files"
      :key="file.path"
      class="group flex h-6 items-center gap-1.5 border-b border-border-subtle pl-2 pr-1 hover:bg-hover"
      :class="file.path === props.selectedPath && 'bg-accent-soft text-accent-text'"
      data-testid="vcs-change"
      :data-path="file.path"
      :data-state="file.state"
      @click="emit('select', file.path)"
    >
      <InfoTip :label="describe(file)">
        <span class="w-3 shrink-0 text-center text-2xs" :class="MARK[file.state].tone">
          {{ MARK[file.state].letter }}
        </span>
      </InfoTip>
      <button type="button" class="min-w-0 flex-1 truncate text-left text-sm">
        {{ file.path }}
      </button>
      <TooltipButton
        v-if="props.discardable"
        size="xs"
        tone="danger"
        :icon="Undo2"
        label="Discard the changes to this file"
        testid="vcs-discard"
        :disabled="props.disabled"
        class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        @click="discard($event, file.path)"
      />
    </div>
  </div>
</template>
