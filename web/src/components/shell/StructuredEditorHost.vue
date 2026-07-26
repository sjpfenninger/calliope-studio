<script setup lang="ts">
/**
 * Dispatches a section or entry tab to its structured editor.
 *
 * Lifted out of the old editor panel so the tab body stays about layout. The tab
 * is narrowed to the two kinds that have a section, so none of this needs the
 * non-null assertions the previous version was full of.
 */
import ConfigEditor from "@/components/editor/ConfigEditor.vue";
import DataTablesEditor from "@/components/editor/DataTablesEditor.vue";
import LinksEditor from "@/components/editor/LinksEditor.vue";
import NodesEditor from "@/components/editor/NodesEditor.vue";
import TechsEditor from "@/components/editor/TechsEditor.vue";
import type { EntryTab, SectionTab } from "@/stores/tabs";

const props = defineProps<{
  tab: SectionTab | EntryTab;
  versionId: string;
}>();

/** Null for a section tab, which shows every entry. */
const entryName = () => (props.tab.kind === "entry" ? props.tab.entryName : null);
</script>

<template>
  <div class="h-full overflow-auto">
    <ConfigEditor
      v-if="tab.section === 'config'"
      :versionId="versionId"
      :filePath="tab.filePath"
      :tabId="tab.id"
    />
    <DataTablesEditor
      v-else-if="tab.section === 'data_tables'"
      :versionId="versionId"
      :filePath="tab.filePath"
      :tabId="tab.id"
    />
    <TechsEditor
      v-else-if="tab.section === 'techs'"
      :versionId="versionId"
      :filePath="tab.filePath"
      :tabId="tab.id"
      :entryName="entryName()"
    />
    <NodesEditor
      v-else-if="tab.section === 'nodes'"
      :versionId="versionId"
      :filePath="tab.filePath"
      :tabId="tab.id"
      :entryName="entryName()"
    />
    <LinksEditor
      v-else-if="tab.section === 'links'"
      :versionId="versionId"
      :filePath="tab.filePath"
      :tabId="tab.id"
      :entryName="entryName()"
    />
    <p v-else class="p-3 text-sm text-muted-foreground">
      No structured editor for this section yet — use the Raw view.
    </p>
  </div>
</template>
