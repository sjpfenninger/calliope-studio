<script setup lang="ts">
/**
 * Why a pane is read-only: another buffer holds unsaved changes to its file.
 *
 * A file may have unsaved changes in at most one buffer (`tabs.dirtyOwner`).
 * The second one — the Links form while Techs is dirty on the same `techs:`
 * section, the raw view of a form that has edits, a CSV tab while a data-table
 * tab holds that CSV — shows this instead of taking edits it would later merge
 * against a baseline the first buffer has replaced.
 *
 * Two ways out, both the user's to choose. *Go there* fronts the tab holding
 * the edits so they can be saved. *Discard* forgets them, after asking, and
 * tells every buffer on the affected files to re-read the disk — through the
 * same channel a save announces itself on, since to a buffer the two are the
 * same event.
 */
import { Lock } from "@lucide/vue";

import Banner from "./Banner.vue";
import { GHOST_BUTTON, IDENTIFIER } from "@/lib/formClasses";
import { useConfirmStore } from "@/stores/confirm";
import { useSectionDataStore } from "@/stores/sectionData";
import { useTabsStore, type DirtyOwner } from "@/stores/tabs";

const props = defineProps<{
  owner: DirtyOwner;
  /** The file this pane edits, model-relative. */
  file: string;
}>();

const tabs = useTabsStore();
const confirm = useConfirmStore();
const sections = useSectionDataStore();

function goThere(): void {
  tabs.activate(props.owner.tabId);
}

async function discard(): Promise<void> {
  const ok = await confirm.ask({
    title: `Discard the unsaved changes in ${props.owner.title}?`,
    message: "That tab will go back to what is on disk. Nothing has been written.",
    confirmLabel: "Discard",
    destructive: true,
  });
  if (!ok) return;
  for (const path of tabs.discardEdits(props.owner.tabId)) {
    if (tabs.versionId) sections.invalidateFile(tabs.versionId, path);
    sections.requestReload(path);
  }
}
</script>

<template>
  <Banner tone="warning" :icon="Lock" testid="locked-banner">
    <span :class="IDENTIFIER">{{ file }}</span> has unsaved changes in
    <span class="font-medium">{{ owner.title }}</span>. Save or discard them to edit here.
    <template #action>
      <button type="button" :class="GHOST_BUTTON" data-testid="locked-go" @click="goThere">
        Go there
      </button>
      <button
        type="button"
        :class="GHOST_BUTTON"
        data-testid="locked-discard"
        @click="discard"
      >
        Discard those changes
      </button>
    </template>
  </Banner>
</template>
