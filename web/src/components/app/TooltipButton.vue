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
  ICON_BUTTON,
  ICON_BUTTON_SM,
} from "@/lib/formClasses";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    /** The tooltip text and the accessible name. Not optional, on purpose. */
    label: string;
    icon: Component;
    tone?: "quiet" | "danger";
    /** 24px (`md`) by default; 20px (`sm`) for an affordance inside a 24px row. */
    size?: "sm" | "md";
    side?: "top" | "right" | "bottom" | "left";
    disabled?: boolean;
    testid?: string;
    class?: string;
  }>(),
  { tone: "quiet", size: "md", side: "top", disabled: false },
);

const emit = defineEmits<{ click: [event: MouseEvent] }>();

const body = computed(() =>
  cn(
    props.tone === "danger"
      ? DANGER_ICON_BUTTON
      : props.size === "sm"
        ? ICON_BUTTON_SM
        : ICON_BUTTON,
    props.class,
  ),
);

const glyph = computed(() => (props.size === "sm" ? "size-3" : "size-3.5"));
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
      <component :is="icon" :class="glyph" />
    </button>
  </InfoTip>
</template>
