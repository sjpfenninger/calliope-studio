<script setup lang="ts">
/**
 * One run in the history list.
 *
 * Two lines, always exactly two: what it is — name and scenario — and what it
 * cost. The second line is the whole reason the Runs section exists as a
 * first-class place — a run's duration, objective and size were previously
 * reachable only by loading the `.nc` file, and its disk usage not at all.
 *
 * Every row the same height is not tidiness for its own sake: the list is read
 * by scanning down it, and one run standing taller than its neighbours because
 * it happens to name a scenario reads as though it were a different kind of
 * thing.
 *
 * Emits rather than acts: deleting results is irreversible, so the confirmation
 * belongs with the list, not with sixty copies of it.
 */
import { computed, nextTick, ref } from "vue";
import InfoTip from "@/components/app/InfoTip.vue";
import Metric from "@/components/app/Metric.vue";
import { FIELD_SM } from "@/lib/formClasses";
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
  <!-- The row reserves the actions button's width on the right, and the button
       sits absolutely inside that gutter. It used to overlay the first line
       instead, on the reasoning that losing the tail of a long scenario was
       cheaper than insetting every row — but the tail vanishes at the moment the
       pointer arrives, which is the moment the scenario is being read. The
       padding is on the row rather than on either line, so the name/scenario
       line and the metrics line keep a single right edge; and the button never
       moves, so nothing reflows under the cursor. -->
  <div
    class="group relative flex flex-col gap-0.5 border-b border-border-subtle py-1 pl-2 pr-7"
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
        :class="cn(FIELD_SM, 'flex-1')"
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="renaming = false"
        @blur="commitRename"
      />
      <!-- The id, not the label: this is the run's identity behind whatever it
           has been renamed to, so it is help rather than an overflow reveal. -->
      <InfoTip v-if="!renaming" :label="run.id">
        <button
          type="button"
          data-testid="run-open"
          class="min-w-0 shrink truncate text-left text-sm"
          @click="emit('open', $event)"
        >
          {{ title }}
        </button>
      </InfoTip>

      <!-- Beside the name, not down with the numbers: it is what distinguishes
           two runs of the same model, and as a fifth item on the metrics row it
           wrapped that row onto a second line — so a run with a scenario stood
           taller than the ones around it and the list lost its rhythm. Pushed
           right, so it and `size` below share one edge rather than each ending
           wherever their text runs out.

           It is the flexible one and the name is not, which is what makes the
           *scenario* truncate first — the name is the thing clicked, and with
           the two the other way round a 44-character scenario left the name
           reading "a.". A `flex-1` here and a bare `shrink` there, because flex
           distributes shortfall in proportion to base size: a basis-0 item
           cannot give anything up, so whichever one carries `flex-1` is the one
           that yields. -->
      <Metric
        v-if="run.scenario && !renaming"
        layout="inline"
        label="scenario"
        :value="run.scenario"
        class="flex-1 justify-end"
      />
    </div>

    <!-- **The tooltip wraps the whole menu, not its trigger.** Reka's `Tooltip`
         provides a popper context of its own, so a `Tooltip` sitting *between* a
         `DropdownMenu` and its `DropdownMenuTrigger` shadows the dropdown's: the
         trigger registers its anchor into the tooltip's popper, the menu's is
         left with none, and floating-ui has nothing to position against. The
         content then stays at Reka's unplaced default, `translate(0, -200%)` —
         so the menu opened, took focus and trapped the pointer, while sitting
         several hundred pixels above the top of the window. Nothing appeared.

         Nesting the other way puts the dropdown's own context nearest its
         trigger. The span is what the tooltip points at, and it carries the
         positioning so it has a real box to be: wrapped around an absolutely
         positioned button it would have measured zero.

         Two `as-child` primitives around one element is *not* the problem —
         that was the first guess, and giving each its own element changed
         nothing. -->
    <InfoTip label="Run actions">
      <span
        class="absolute right-1.5 top-1 inline-flex opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100"
      >
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              aria-label="Run actions"
              data-testid="run-menu"
              class="grid size-5 place-items-center rounded-xs text-text-faint hover:bg-active hover:text-foreground"
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
      </span>
    </InfoTip>

    <!-- Labelled, not run-on: these numbers used to be four unlabelled figures
         with a native `title` as the only clue what they were, which is a missing
         label rather than a tooltip problem. -->
    <!-- One line, never two: with the scenario moved up to the name this row is
         back to the four short figures it was built for, and every run in the
         list is the same height whichever of them it has. It was allowed to wrap
         only because the scenario made it five. -->
    <div class="flex items-center gap-x-2 text-text-faint">
      <InfoTip :label="formatTimestamp(run.created_at)">
        <span class="shrink-0 text-2xs">{{ formatRelativeTime(run.created_at) }}</span>
      </InfoTip>
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
