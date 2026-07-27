<script setup lang="ts">
/**
 * Dispatches a section or entry tab to its structured editor.
 *
 * Lifted out of the old editor panel so the tab body stays about layout. The tab
 * is narrowed to the two kinds that have a section, so none of this needs the
 * non-null assertions the previous version was full of.
 *
 * The wrapper below is a **flex column**, not `h-full overflow-auto`. Every
 * structured editor's root is `flex min-h-0 flex-1 flex-col` with its own
 * scrolling region inside, which only works if this container is a flex box —
 * against a block parent `flex-1` is inert, each editor's height collapses to
 * its content, and anything sized as a fraction of it gets nothing. That is
 * exactly how the nodes map came to render at zero height and draw nothing at
 * all: `height: 100%` of an auto-height parent is `auto`, and `auto` of an empty
 * map container is 0.
 */
import ConfigEditor from "@/components/editor/ConfigEditor.vue";
import DataTablesEditor from "@/components/editor/DataTablesEditor.vue";
import LinksEditor from "@/components/editor/LinksEditor.vue";
import NodesEditor from "@/components/editor/NodesEditor.vue";
import OverridesEditor from "@/components/editor/OverridesEditor.vue";
import ScenariosEditor from "@/components/editor/ScenariosEditor.vue";
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
  <div class="flex h-full min-h-0 flex-col">
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
      :entryName="entryName()"
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
    <OverridesEditor
      v-else-if="tab.section === 'overrides'"
      :versionId="versionId"
      :filePath="tab.filePath"
      :tabId="tab.id"
      :entryName="entryName()"
    />
    <ScenariosEditor
      v-else-if="tab.section === 'scenarios'"
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
