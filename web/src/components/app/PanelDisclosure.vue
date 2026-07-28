<script setup lang="ts">
/**
 * The title of a panel, doubling as its collapse control.
 *
 * Only the chevron and the label are clickable, deliberately. The headers this
 * sits in are dense strips of variable pickers and toggle groups, and making the
 * whole 28px bar a collapse target means a click that misses a `Select` by two
 * pixels folds away the figure the user was about to configure. A named target is
 * a smaller one, and it is the one that cannot be hit by accident.
 *
 * The chevron idiom is the accordion's, down to the rotation — `components/ui/
 * accordion/AccordionTrigger.vue`. It is not the accordion itself because a
 * splitter panel owns its own collapsed state and its height is a drag, not a
 * content measurement.
 */
import { ChevronDown } from "@lucide/vue";
import type { HTMLAttributes } from "vue";

import InfoTip from "./InfoTip.vue";
import PanelTitle from "./PanelTitle.vue";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    /** Whether the panel it controls is showing its contents. */
    open: boolean;
    /** Named in the accessible label, so the button says what it collapses. */
    label: string;
    /**
     * Why it cannot be collapsed right now, or empty when it can.
     *
     * A string rather than a boolean: a control that is disabled without saying
     * why reads as broken, and this one is disabled for a reason the user can act
     * on — expand something else first.
     */
    lockedReason?: string;
    testid?: string;
    class?: HTMLAttributes["class"];
  }>(),
  { lockedReason: "", testid: undefined },
);

const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <InfoTip :label="props.lockedReason">
    <button
      type="button"
      :aria-expanded="props.open"
      :aria-label="`${props.open ? 'Collapse' : 'Expand'} ${props.label}`"
      :aria-disabled="Boolean(props.lockedReason)"
      :data-state="props.open ? 'open' : 'closed'"
      :data-testid="props.testid"
      :class="
        cn(
          'flex h-5 min-w-0 shrink-0 items-center gap-1 rounded-xs px-1',
          'transition-colors hover:bg-hover',
          '[&[data-state=open]>svg]:rotate-0 [&[data-state=closed]>svg]:-rotate-90',
          props.lockedReason && 'cursor-default opacity-50 hover:bg-transparent',
          props.class,
        )
      "
      @click="props.lockedReason || emit('toggle')"
    >
      <ChevronDown
        class="size-3 shrink-0 text-text-faint transition-transform duration-slow"
      />
      <PanelTitle>
        <slot>{{ props.label }}</slot>
      </PanelTitle>
    </button>
  </InfoTip>
</template>
