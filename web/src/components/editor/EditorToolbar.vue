<script setup lang="ts">
/**
 * The strip at the top of every structured editor.
 *
 * All five had their own copy of "a Save button, a keyboard hint, and sometimes
 * something else", at three different heights. One 32px strip, matching the tab
 * bar above it and the section toolbars in the sidebar.
 */
import { Loader2, Save } from "lucide-vue-next";

import { ICON_STROKE_WIDTH } from "@/lib/icons";
import { PRIMARY_BUTTON } from "@/lib/formClasses";

defineProps<{ saving?: boolean; disabled?: boolean }>();
defineEmits<{ save: [] }>();
</script>

<template>
  <div
    class="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-panel px-2"
  >
    <button
      type="button"
      data-testid="save"
      :class="PRIMARY_BUTTON"
      :disabled="saving || disabled"
      @click="$emit('save')"
    >
      <component
        :is="saving ? Loader2 : Save"
        class="size-3.5"
        :class="saving ? 'animate-spin' : ''"
        :stroke-width="ICON_STROKE_WIDTH"
      />
      Save
    </button>
    <span class="text-2xs text-text-faint">or Ctrl/Cmd+S</span>

    <slot />
  </div>
</template>
