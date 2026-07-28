<script setup lang="ts" generic="T extends string">
/**
 * The one segmented control, in two modes.
 *
 * See `segmented.ts` for the rule the modes encode. `nav` renders plain buttons
 * or RouterLinks rather than Reka's Tabs: a roving tabindex fights RouterLinks
 * and disabled segments, which is the same lesson `TabBar`'s docblock already
 * records. `value` is a plain button group too, so both modes share one set of
 * classes and cannot drift.
 *
 * A disabled segment with a tooltip gets a focusable wrapper, because neither a
 * native `title` nor a tooltip trigger fires on a disabled element — the sidebar
 * has exactly that case ("Not available for a results file") and it silently did
 * nothing before. An enabled one gets an ordinary tooltip: `tip` used to be read
 * only when the segment was disabled, so a strip whose labels are short enough to
 * need explaining — the results view's layouts — had nowhere to put it.
 */
import { computed, type Component, type HTMLAttributes } from "vue";
import type { RouteLocationRaw } from "vue-router";

import InfoTip from "./InfoTip.vue";
import {
  SEGMENT_BASE,
  SEGMENT_NAV_ACTIVE,
  SEGMENT_NAV_SEAM,
  SEGMENT_SIZE,
  SEGMENT_VALUE_ACTIVE,
} from "./segmented";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface SegmentItem<V extends string> {
  value: V;
  label: string;
  icon?: Component;
  /** A count beside the label — validation errors, say. */
  badge?: string | number;
  badgeVariant?: "default" | "secondary" | "destructive" | "outline";
  disabled?: boolean;
  /** Tooltip text. Never rendered as a native `title`. */
  tip?: string;
  /** Renders a RouterLink instead of a button. */
  to?: RouteLocationRaw;
  /** Forwarded verbatim as `data-testid`. */
  testid?: string;
}

const props = withDefaults(
  defineProps<{
    items: SegmentItem<T>[];
    /** `nav` changes what the adjacent region shows; `value` sets a value. */
    mode?: "nav" | "value";
    size?: "sm" | "md";
    /**
     * Which surface the active segment opens into — whatever is below the strip.
     * `surface` over an editor or a card, `panel` over more sidebar, `none` for a
     * secondary switcher with no single surface beneath it.
     */
    seam?: "surface" | "panel" | "none";
    /** Segments grow to share the width, for a strip that spans its container. */
    fill?: boolean;
    class?: HTMLAttributes["class"];
  }>(),
  { mode: "nav", size: "sm", seam: "surface", fill: false },
);

const model = defineModel<T>();

const activeClass = computed(() =>
  props.mode === "nav"
    ? cn(SEGMENT_NAV_ACTIVE, SEGMENT_NAV_SEAM[props.seam])
    : SEGMENT_VALUE_ACTIVE,
);

const segmentClass = computed(() =>
  cn(SEGMENT_BASE, SEGMENT_SIZE[props.size], activeClass.value),
);

const rootClass = computed(() => cn("flex items-stretch", props.class));

function isActive(item: SegmentItem<T>): true | undefined {
  return model.value === item.value || undefined;
}
</script>

<template>
  <div :class="rootClass" role="group">
    <template v-for="item in items" :key="item.value">
      <!-- A disabled control cannot host a tooltip trigger — neither a native
           `title` nor a pointer listener fires on one — so the trigger is a
           focusable wrapper and the button stays a real, disabled button. It
           keeps its own data-testid either way: a caller asking whether a
           segment is enabled must get a truthful answer. -->
      <InfoTip v-if="item.disabled && item.tip" :label="item.tip">
        <span :class="fill && 'flex flex-auto'" tabindex="0">
          <component
            :is="item.to ? 'RouterLink' : 'button'"
            v-bind="item.to ? { to: item.to } : { type: 'button' }"
            :data-testid="item.testid"
            disabled
            aria-disabled="true"
            :class="cn(segmentClass, fill && 'w-full flex-auto')"
          >
            <component :is="item.icon" v-if="item.icon" class="size-3.5 shrink-0" />
            <span class="truncate">{{ item.label }}</span>
          </component>
        </span>
      </InfoTip>

      <!-- An enabled segment may carry a tip too. `InfoTip` passes its slot
           straight through when the label is empty, so this is one branch rather
           than a third copy of the button. -->
      <InfoTip v-else :label="item.tip ?? ''">
        <component
          :is="item.to ? 'RouterLink' : 'button'"
          v-bind="item.to ? { to: item.to } : { type: 'button' }"
          :data-testid="item.testid"
          :data-active="isActive(item)"
          :disabled="item.to ? undefined : item.disabled"
          :class="cn(segmentClass, fill && 'flex-auto')"
          @click="item.to ? undefined : (model = item.value)"
        >
          <component :is="item.icon" v-if="item.icon" class="size-3.5 shrink-0" />
          <span class="truncate">{{ item.label }}</span>
          <Badge
            v-if="item.badge !== undefined"
            :variant="item.badgeVariant ?? 'destructive'"
            class="h-4 px-1 tabular-nums"
          >
            {{ item.badge }}
          </Badge>
        </component>
      </InfoTip>
    </template>
  </div>
</template>
