<script setup lang="ts">
/**
 * The strip at the top of every structured editor.
 *
 * All five had their own copy of "a Save button, a keyboard hint, and sometimes
 * something else", at three different heights. One 32px strip, matching the tab
 * bar above it and the section toolbars in the sidebar.
 *
 * `bg-surface`, not the chrome tone `PanelHeader` defaults to: this strip is the
 * first thing under the tab bar, and the active tab opens onto it. On `--cg-panel`
 * the tab bled into a tone one step back from itself, which undoes what the seam
 * is for. Its `border-b` stays — it still has to divide itself from the body.
 *
 * **A failed save reports itself here, beside the button that caused it.** Five
 * of the seven editors used to have no `catch` at all, so a rejected PUT became
 * an unhandled promise rejection and the user was told nothing — in an app whose
 * whole purpose is editing files, with no toast mechanism anywhere to fall back
 * on. The two that did report it disagreed about where: one reused the *load*
 * error, whose `StateMessage` replaces the entire editor and so would have
 * unmounted the very edits that failed to save, and the other invented a span in
 * its own toolbar slot. The strip is the honest place — it is already the one
 * thing every editor shares, it already owns `saving`, and it cannot hide the
 * form. `role="alert"` because the failure is silent otherwise.
 */
import { Loader2, Save, TriangleAlert } from "@lucide/vue";
import PanelHeader from "@/components/app/PanelHeader.vue";

import { PRIMARY_BUTTON } from "@/lib/formClasses";
import { ICON_STROKE_WIDTH_TIGHT } from "@/lib/icons";

defineProps<{
  saving?: boolean;
  disabled?: boolean;
  /** Why the last save failed, if it did. */
  error?: string | null;
}>();
defineEmits<{ save: [] }>();
</script>

<template>
  <PanelHeader class="bg-surface">
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

    <span
      v-if="error"
      role="alert"
      data-testid="save-error"
      class="ml-auto flex min-w-0 items-center gap-1 text-2xs text-danger-text"
    >
      <TriangleAlert class="size-3 shrink-0" :stroke-width="ICON_STROKE_WIDTH_TIGHT" />
      <span class="truncate">{{ error }}</span>
    </span>
  </PanelHeader>
</template>
