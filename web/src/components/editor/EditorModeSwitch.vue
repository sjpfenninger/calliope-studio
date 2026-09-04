<script setup lang="ts">
/**
 * Form or Source, for a section or entry tab.
 *
 * `tabs.setEditorMode` and everything downstream of it — the raw buffer
 * `TabBody` keeps `v-show`n, `useSectionEditor`'s refusal to answer Cmd+S from
 * the wrong mode, the lock banner on a raw view whose form holds edits — had
 * no caller: every section tab was created `structured` and nothing ever
 * changed it, so the Raw view the app documented could not be reached, and the
 * one section with no structured editor (`templates`) told the user to use it.
 *
 * The same control in both places the mode can be switched from, so it cannot
 * drift between them: `EditorToolbar` shows it over the form, and
 * `MonacoYamlEditor`'s header shows it over the buffer. `nav` mode, because it
 * changes what the pane below shows, and the seam opens onto the tab's own
 * surface — the pattern `TabBody`'s Preview/Source switch already set.
 */
import { computed } from "vue";
import { FileCode2, ListTree } from "@lucide/vue";

import Segmented from "@/components/app/Segmented.vue";
import { useTabsStore, type EditorMode } from "@/stores/tabs";

const props = defineProps<{ tabId: string }>();

const tabs = useTabsStore();

const MODES = [
  { value: "structured" as const, label: "Form", icon: ListTree, testid: "mode-form" },
  { value: "raw" as const, label: "Source", icon: FileCode2, testid: "mode-source" },
];

const mode = computed<EditorMode>({
  get: () => {
    const tab = tabs.get(props.tabId);
    return tab?.kind === "section" || tab?.kind === "entry" ? tab.editorMode : "structured";
  },
  set: (next) => tabs.setEditorMode(props.tabId, next),
});
</script>

<template>
  <!-- `seam="none"`: this switcher sits mid-toolbar among other buttons, so the
       tab-bar bridge over the strip's hairline read as the border breaking under
       one control rather than as a tab opening into the pane. Colour alone
       carries the state, as it does for the run sub-tabs. -->
  <Segmented v-model="mode" :items="MODES" mode="nav" size="fill" seam="none" />
</template>
