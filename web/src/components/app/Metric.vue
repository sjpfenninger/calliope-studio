<script setup lang="ts">
/**
 * A labelled number.
 *
 * The app had no shared way to present one, and it showed: a run row rendered
 * objective, duration and size as a run-on line of 10px grey text with native
 * `title` attributes as the only clue what the numbers *were*. A `title` that
 * carries different information than the visible text is not a tooltip problem,
 * it is a missing label — so labelling them here is what retires those.
 *
 * Presentation only. Formatting lives in `lib/format.ts`, which already knows
 * that "3.4 MB" beats "3417 kB" and that a nullish value reads "—"; callers pass
 * the formatted string.
 */
import { computed, type HTMLAttributes } from "vue";
import InfoTip from "./InfoTip.vue";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number | null | undefined;
    unit?: string;
    /** `stacked` for a summary strip, `inline` for a dense list row. */
    layout?: "stacked" | "inline";
    /**
     * Two steps, because the type scale has two above body and no more.
     *
     * There was a third, `lg`, mapped to `text-xl` — a step `style.css` states
     * is *deliberately absent*, so it silently fell back to Tailwind's stock
     * 20px/28px, off the scale in both dimensions. Nothing ever asked for it.
     */
    size?: "sm" | "md";
    tone?: "default" | "success" | "warning" | "danger";
    /** An explanation, on the label. */
    hint?: string;
    class?: HTMLAttributes["class"];
  }>(),
  { layout: "stacked", size: "md", tone: "default" },
);

const VALUE_SIZE = { sm: "text-sm", md: "text-lg" } as const;

// The value one step above the label, in both layouts. `default` is `dim`
// rather than full foreground because a metric is an annotation on the thing
// it describes — a run row's name is the foreground, its duration is not — and
// the stacked layout used to give the label a *third* tone (`SECTION_HEADING`'s
// faint) that the inline one did not, so the same label read differently by
// where it sat.
const TONE = {
  default: "text-text-dim",
  success: "text-success-text",
  warning: "text-warning-text",
  danger: "text-danger-text",
} as const;

const shown = computed(() =>
  props.value === null || props.value === undefined || props.value === ""
    ? "—"
    : String(props.value),
);

/**
 * The label's class, once.
 *
 * It was written out twice, in the two branches of a `v-if` that differ only in
 * whether an `InfoTip` wraps the span — so a change to one of them had to be
 * remembered in the other, and both carried the same broken token for as long as
 * they existed.
 */
const labelClass = "truncate text-2xs text-text-muted";
</script>

<template>
  <div
    :class="
      cn(
        layout === 'stacked'
          ? 'flex min-w-0 flex-col gap-0.5'
          : 'flex min-w-0 items-baseline gap-1',
        props.class,
      )
    "
  >
    <InfoTip v-if="hint" :label="hint">
      <span :class="labelClass">{{ label }}</span>
    </InfoTip>
    <span v-else :class="labelClass">{{ label }}</span>

    <span
      class="flex min-w-0 items-baseline gap-1 tabular-nums"
      :class="TONE[tone]"
    >
      <span
        class="truncate font-medium"
        :class="layout === 'stacked' ? VALUE_SIZE[size] : 'text-2xs'"
      >{{ shown }}</span>
      <span v-if="unit" class="shrink-0 text-2xs text-text-muted">{{ unit }}</span>
    </span>
  </div>
</template>
