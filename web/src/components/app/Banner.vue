<script setup lang="ts">
/**
 * A strip across the top of a pane that says something about its state: a file
 * held by another tab, a save that failed, a read-only view.
 *
 * One shape, in three tones, because there were three shapes for the one role
 * and they escalated backwards — a *save failure* was un-washed danger text on
 * the plain surface, while the lower-severity lock notice nineteen lines below
 * it in the same file had an amber wash, and the data-table editor drew a third
 * at 10px directly above a real `LockedBanner`. The geometry is `LockedBanner`'s,
 * which was the one that had been looked at: 32px, 12px text, a leading glyph.
 *
 * The actions inside it inherit the tone rather than carrying `GHOST_BUTTON`'s
 * own grey: a "Reload" in a red strip that is painted in the disabled colour
 * says the opposite of what a recovery action should.
 */
import { CircleAlert, Info, TriangleAlert } from "@lucide/vue";
import { computed, type Component, type HTMLAttributes } from "vue";

import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    tone?: "info" | "warning" | "danger";
    icon?: Component;
    testid?: string;
    class?: HTMLAttributes["class"];
  }>(),
  { tone: "info", icon: undefined, testid: undefined },
);

const TONE = {
  info: "bg-surface-2 text-text-dim",
  warning: "bg-warning-soft text-warning-text",
  danger: "bg-danger-soft text-danger-text",
} as const;

const GLYPH = { info: Info, warning: TriangleAlert, danger: CircleAlert } as const;

const glyph = computed(() => props.icon ?? GLYPH[props.tone]);

const classes = computed(() =>
  cn(
    "flex h-8 shrink-0 items-center gap-2 border-b border-border px-2 text-sm",
    TONE[props.tone],
    props.class,
  ),
);
</script>

<template>
  <div :role="tone === 'danger' ? 'alert' : 'status'" :data-testid="testid" :class="classes">
    <component :is="glyph" class="size-3.5 shrink-0" />
    <span class="min-w-0 flex-1 truncate"><slot /></span>
    <!-- `GHOST_BUTTON` sets `text-text-dim`; `text-current` on the wrapper cannot
         override that, so the actions in a banner are asked to inherit through
         the `[&_button]` step. Every action in a strip is a ghost button. -->
    <span class="flex shrink-0 items-center gap-1 [&_button]:text-current">
      <slot name="action" />
    </span>
  </div>
</template>
