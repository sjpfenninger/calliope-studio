<script setup lang="ts">
import type { TooltipContentEmits, TooltipContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { TooltipArrow, TooltipContent, TooltipPortal, useForwardPropsEmits } from "reka-ui"
import { cn } from "@/lib/utils"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(defineProps<TooltipContentProps & { class?: HTMLAttributes["class"] }>(), {
  sideOffset: 4,
})

const emits = defineEmits<TooltipContentEmits>()

const delegatedProps = reactiveOmit(props, "class")
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <TooltipPortal>
    <TooltipContent
      data-slot="tooltip-content"
      v-bind="{ ...forwarded, ...$attrs }"
      :class="cn('bg-foreground text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-tooltip isolate w-fit rounded-sm px-1.5 py-1 text-2xs shadow-md text-balance', props.class)"
    >
      <!--
        The text is raised, because the arrow cannot be lowered. The arrow
        straddles the bubble's edge and its inner half reaches ~9px in, well past
        `py-1`, so it lands on the first line — and reka draws it as an
        absolutely positioned `span` it builds itself, with our class on the
        static `svg` inside, where `z-index` does nothing at all. Stock
        shadcn-vue puts `z-50` there; it has never had any effect. A positioned
        element after the text in the DOM wins on paint order, so the only place
        left to fix it is the text, and `isolate` above keeps this `z-10` from
        meaning anything outside the bubble.
      -->
      <span class="relative z-10"><slot /></span>

      <TooltipArrow class="bg-foreground fill-foreground size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-xs" />
    </TooltipContent>
  </TooltipPortal>
</template>
