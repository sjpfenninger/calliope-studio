<script setup lang="ts">
/**
 * One run in the history list.
 *
 * Two lines: what it is, and what it cost. The second line is the whole reason
 * the Runs section exists as a first-class place — a run's duration, objective
 * and size were previously reachable only by loading the `.nc` file, and its
 * disk usage not at all.
 *
 * Emits rather than acts: deleting results is irreversible, so the confirmation
 * belongs with the list, not with sixty copies of it.
 */
import { computed, nextTick, ref } from "vue";
import InfoTip from "@/components/app/InfoTip.vue";
import Metric from "@/components/app/Metric.vue";
import { FIELD } from "@/lib/formClasses";
import { cn } from "@/lib/utils";
import { MoreHorizontal, Pencil, Square, Trash2 } from "@lucide/vue";

import RunStatusPill from "./RunStatusPill.vue";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  formatBytes,
  formatDuration,
  formatObjective,
  formatRelativeTime,
  formatTimestamp,
} from "@/lib/format";
import { isTerminal, type RunRecord } from "@/stores/runs";

const props = defineProps<{
  run: RunRecord;
  /** Whether this run's tab is the one in front. */
  active: boolean;
}>();

const emit = defineEmits<{
  /** Carries the click, so Cmd-click can mean "in a tab that stays". */
  open: [event: MouseEvent];
  rename: [label: string];
  cancel: [];
  remove: [];
}>();

const renaming = ref(false);
const draft = ref("");
const field = ref<HTMLInputElement | null>(null);

const running = computed(() => !isTerminal(props.run.status));

/** A run has a name only if it was given one; otherwise its id stands in. */
const title = computed(() => props.run.label || props.run.id.slice(0, 8));

async function startRename() {
  draft.value = props.run.label ?? "";
  renaming.value = true;
  await nextTick();
  field.value?.focus();
  field.value?.select();
}

function commitRename() {
  if (!renaming.value) return;
  renaming.value = false;
  const label = draft.value.trim();
  if (label !== (props.run.label ?? "")) emit("rename", label);
}
</script>

<template>
  <div
    class="group relative flex flex-col gap-0.5 border-b border-border-subtle px-2 py-1"
    :class="active ? 'bg-active' : 'hover:bg-hover'"
    data-testid="run-item"
    :data-run-id="run.id"
  >
    <div class="flex items-center gap-1.5">
      <RunStatusPill :status="run.status" dot-only />

      <input
        v-if="renaming"
        ref="field"
        v-model="draft"
        type="text"
        data-testid="run-rename"
        :class="cn(FIELD, 'h-5 flex-1 px-1')"
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="renaming = false"
        @blur="commitRename"
      />
      <button
        v-else
        type="button"
        data-testid="run-open"
        class="min-w-0 flex-1 truncate text-left text-sm"
        :title="run.id"
        @click="emit('open', $event)"
      >
        {{ title }}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            title="Run actions"
            data-testid="run-menu"
            class="grid size-5 shrink-0 place-items-center rounded-xs text-text-faint opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal class="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="min-w-40">
          <DropdownMenuItem @select="startRename">
            <Pencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem v-if="running" @select="emit('cancel')">
            <Square />
            Cancel run
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            data-testid="run-delete"
            :disabled="running"
            @select="emit('remove')"
          >
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <!-- Labelled, not run-on: these numbers used to be four unlabelled figures
         with a native `title` as the only clue what they were, which is a missing
         label rather than a tooltip problem. -->
    <div class="flex items-center gap-2 text-text-faint">
      <InfoTip :label="formatTimestamp(run.created_at)">
        <span class="shrink-0 text-2xs">{{ formatRelativeTime(run.created_at) }}</span>
      </InfoTip>
      <Metric
        v-if="run.scenario"
        layout="inline"
        label="scenario"
        :value="run.scenario"
        class="min-w-0 shrink"
      />
      <Metric
        v-if="run.duration_seconds != null"
        layout="inline"
        label="took"
        :value="formatDuration(run.duration_seconds)"
      />
      <Metric
        v-if="run.objective != null"
        layout="inline"
        label="obj"
        :value="formatObjective(run.objective)"
      />
      <Metric
        layout="inline"
        label="size"
        :value="formatBytes(run.size_bytes)"
        class="ml-auto shrink-0"
      />
    </div>
  </div>
</template>
