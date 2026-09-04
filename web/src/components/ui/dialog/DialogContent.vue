<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { X } from "@lucide/vue"
import { reactiveOmit } from "@vueuse/core"
import {
  DialogClose,
  DialogContent,
  DialogPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { ICON_BUTTON } from "@/lib/formClasses"
import { cn } from "@/lib/utils"
import DialogOverlay from "./DialogOverlay.vue"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(defineProps<DialogContentProps & { class?: HTMLAttributes["class"], showCloseButton?: boolean }>(), {
  showCloseButton: true,
})
const emits = defineEmits<DialogContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <DialogPortal>
    <DialogOverlay />
    <DialogContent
      data-slot="dialog-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="
        cn(
          'bg-surface data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-dialog grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-3 rounded-lg border p-4 shadow-lg duration-slow sm:max-w-lg',
          props.class,
        )"
    >
      <slot />

      <!-- `ICON_BUTTON`, not shadcn's own opacity fade: a bare button around a
           14px glyph is a ~14px hit target, and the fade is a hover treatment
           used nowhere else here. `top-4 right-4` is the content's own `p-4`
           edge, so nothing moves. A dialog with a header action turns this off
           and puts its own close in the row — see `ImportGraphDialog`. -->
      <DialogClose
        v-if="showCloseButton"
        data-slot="dialog-close"
        :class="cn(ICON_BUTTON, 'absolute top-4 right-4')"
      >
        <X class="size-3.5" />
        <span class="sr-only">Close</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
