<script setup lang="ts">
/**
 * The strip at the top of every structured editor.
 *
 * All five had their own copy of "a Save button, a keyboard hint, and sometimes
 * something else", at three different heights. One 32px strip, matching the tab
 * bar above it and the section toolbars in the sidebar.
 *
 * `tone="surface"`, not the chrome tone `PanelHeader` defaults to: this strip is
 * the first thing under the tab bar, and the active tab opens onto it. On
 * `--cg-panel` the tab bled into a tone one step back from itself, which undoes
 * what the seam is for. Its `border-b` stays — it still has to divide itself
 * from the body.
 *
 * **Save is disabled while there is nothing to save**, and says so. It used to
 * be live on a clean form and PUT the section regardless, while the CSV editor
 * silently returned and the data-tables editor wrote half — three answers to
 * one keystroke. The button is the one that can explain itself, so it is the
 * one that refuses; Cmd+S still goes through the composable, which is what
 * `save-check` uses to prove a no-op write is faithful.
 *
 * **A failed save reports itself here, beside the button that caused it.** Five
 * of the seven editors used to have no `catch` at all, so a rejected PUT became
 * an unhandled promise rejection and the user was told nothing — in an app whose
 * whole purpose is editing files, with no toast mechanism anywhere to fall back
 * on. The two that did report it disagreed about where: one reused the *load*
 * error, whose `StateMessage` replaces the entire editor and so would have
 * unmounted the very edits that failed to save, and the other invented a span in
 * its own toolbar slot. A `Banner` under the strip is the honest place — it is
 * already the one thing every editor shares, it already owns `saving`, and it
 * cannot hide the form. `role="alert"` because the failure is silent otherwise.
 *
 * **It also names the file being written**, which nothing else on screen did. A
 * section tab is `(section, filePath)` — a model defining `techs:` in two files
 * gives two tabs both labelled "Techs", each reading and saving only its own —
 * so "Add technology" had a destination the user could not see. Unconditional,
 * and on every editor: making it depend on the tab kind is the per-editor
 * divergence this component and `useSectionEditor` exist to end. Shortened from
 * the *head*, because the tail is the part that tells two files apart.
 *
 * The Form/Source switch sits beside the path, for the tabs that have a source:
 * a section or an entry. A CSV tab passes its id too, for the Save button's
 * sake, and gets no switch.
 */
import { computed } from "vue";
import { Loader2, Save } from "@lucide/vue";
import Banner from "@/components/app/Banner.vue";
import InfoTip from "@/components/app/InfoTip.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import EditorModeSwitch from "./EditorModeSwitch.vue";

import { shortenPath } from "@/lib/format";
import { GHOST_BUTTON, PRIMARY_BUTTON } from "@/lib/formClasses";
import { useTabsStore } from "@/stores/tabs";

const props = defineProps<{
  saving?: boolean;
  disabled?: boolean;
  /** Why the last save failed, if it did. */
  error?: string | null;
  /**
   * The failure was a stale baseline: the file changed on disk after it was
   * loaded here. Offers the one remedy, which is to reload and lose the edits.
   */
  conflict?: boolean;
  /** The file this editor reads and writes, relative to the model root. */
  file?: string | null;
  /** The tab this editor is for: what Save reads, and what the switch flips. */
  tabId?: string | null;
}>();
defineEmits<{ save: []; reload: [] }>();

const tabs = useTabsStore();

const tab = computed(() => (props.tabId ? tabs.get(props.tabId) : undefined));

const hasSource = computed(
  () => tab.value?.kind === "section" || tab.value?.kind === "entry",
);

/** Clean, with a tab to ask — an editor mounted without one keeps its old button. */
const clean = computed(() => tab.value !== undefined && !tab.value.isDirty);

const saveDisabled = computed(() => props.saving || props.disabled || clean.value);

/** Only the case the button can explain; a lock has its own banner. */
const saveTip = computed(() => (clean.value && !props.disabled ? "Nothing to save" : ""));
</script>

<template>
  <PanelHeader tone="surface">
    <!-- A disabled button fires no pointer events, so the reason it is dead
         goes on a focusable wrapper — `TooltipButton`'s answer to the same
         problem. -->
    <InfoTip :label="saveTip">
      <span class="inline-flex" :tabindex="saveTip ? 0 : undefined">
        <button
          type="button"
          data-testid="save"
          :class="PRIMARY_BUTTON"
          :disabled="saveDisabled"
          @click="$emit('save')"
        >
          <component
            :is="saving ? Loader2 : Save"
            class="size-3.5"
            :class="saving ? 'animate-spin' : ''"
          />
          Save
        </button>
      </span>
    </InfoTip>
    <span class="text-sm text-text-muted">or Ctrl/Cmd+S</span>

    <slot />

    <EditorModeSwitch v-if="hasSource && tabId" :tab-id="tabId" class="ml-auto" />

    <InfoTip v-if="file" :label="file">
      <span
        data-testid="editor-file"
        class="min-w-0 truncate text-sm text-text-muted"
        :class="hasSource ? '' : 'ml-auto'"
      >
        {{ shortenPath(file, 2) }}
      </span>
    </InfoTip>
  </PanelHeader>

  <Banner v-if="error" tone="danger" testid="save-error">
    {{ error }}
    <template #action>
      <button
        v-if="conflict"
        type="button"
        data-testid="reload-from-disk"
        :class="GHOST_BUTTON"
        @click="$emit('reload')"
      >
        Reload
      </button>
    </template>
  </Banner>
</template>
