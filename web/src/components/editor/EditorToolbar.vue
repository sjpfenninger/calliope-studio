<script setup lang="ts">
/**
 * The strip at the top of every structured editor.
 *
 * All five had their own copy of "a Save button, a keyboard hint, and sometimes
 * something else", at three different heights. One 32px strip, matching the tab
 * bar above it and the section toolbars in the sidebar.
 */
import { Loader2, Save } from "@lucide/vue";
import PanelHeader from "@/components/app/PanelHeader.vue";

import { PRIMARY_BUTTON } from "@/lib/formClasses";

defineProps<{ saving?: boolean; disabled?: boolean }>();
defineEmits<{ save: [] }>();
</script>

<template>
  <PanelHeader>
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
      />
      Save
    </button>
    <span class="text-2xs text-text-faint">or Ctrl/Cmd+S</span>

    <slot />
  </PanelHeader>
</template>
