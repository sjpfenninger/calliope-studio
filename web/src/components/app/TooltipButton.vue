<script setup lang="ts">
/**
 * An icon-only button that says what it is.
 *
 * Icon-only controls are the case where a native `title` is not merely worse
 * than a tooltip — several of them had no accessible name at all, so a screen
 * reader announced "button". `label` is both the tooltip text and the
 * `aria-label`, which makes forgetting one of them impossible.
 *
 * The body comes from `formClasses`, so there is still exactly one icon-button
 * geometry rather than the five class strings this replaces.
 */
import { computed, type Component } from "vue";
import InfoTip from "./InfoTip.vue";
import {
  DANGER_ICON_BUTTON,
  DANGER_ICON_BUTTON_SM,
  ICON_BUTTON,
  ICON_BUTTON_SM,
} from "@/lib/formClasses";
import { ICON_STROKE_WIDTH, ICON_STROKE_WIDTH_TIGHT } from "@/lib/icons";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    /** The tooltip text and the accessible name. Not optional, on purpose. */
    label: string;
    icon: Component;
    tone?: "quiet" | "danger";
    /**
     * 24px (`sm`) by default; 20px (`xs`) for an affordance inside a 24px row.
     *
     * Named for the height, like every other control — this was the one place in
     * the app where `sm` meant 20px while `SelectTrigger` and `ToggleGroup` next
     * to it read the same word as 24px. Four figure headers wrote `size="sm"` on
     * all three and got a 20px button beside two 24px controls.
     */
    size?: "xs" | "sm";
    side?: "top" | "right" | "bottom" | "left";
    disabled?: boolean;
    testid?: string;
    class?: string;
  }>(),
  { tone: "quiet", size: "sm", side: "top", disabled: false },
);

const emit = defineEmits<{ click: [event: MouseEvent] }>();

const body = computed(() =>
  cn(
    props.tone === "danger"
      ? props.size === "xs"
        ? DANGER_ICON_BUTTON_SM
        : DANGER_ICON_BUTTON
      : props.size === "xs"
        ? ICON_BUTTON_SM
        : ICON_BUTTON,
    props.class,
  ),
);

const glyph = computed(() => (props.size === "xs" ? "size-3" : "size-3.5"));

/**
 * A `size-3` glyph is below the 14px where the global 1.75 renders under a
 * device pixel, so the small button takes the tight stroke rather than leaving
 * every caller to remember it.
 */
const stroke = computed(() =>
  props.size === "xs" ? ICON_STROKE_WIDTH_TIGHT : ICON_STROKE_WIDTH,
);
</script>

<template>
  <InfoTip :label="label" :side="side">
    <button
      type="button"
      :aria-label="label"
      :data-testid="testid"
      :disabled="disabled"
      :class="body"
      @click="emit('click', $event)"
    >
      <component :is="icon" :class="glyph" :stroke-width="stroke" />
    </button>
  </InfoTip>
</template>
