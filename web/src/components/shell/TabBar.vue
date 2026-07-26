<script setup lang="ts">
/**
 * The one tab bar, shared by editors and runs.
 *
 * Deliberately hand-rolled rather than built on a Tabs primitive: close buttons,
 * dirty dots, overflow scrolling and middle-click-to-close do not fit a
 * `TabsList`, and its roving tabindex fights all of them.
 *
 * 32px tall with a 2px underline that sits *inside* the strip's bottom border,
 * so the active tab appears to break through it.
 */
import { BarChart3 } from "lucide-vue-next";
import { X } from "lucide-vue-next";

import { fileIcon, ICON_STROKE_WIDTH, sectionIcon } from "@/lib/icons";
import { useTabsStore, type TabEntry } from "@/stores/tabs";

const tabs = useTabsStore();

function iconFor(tab: TabEntry) {
  if (tab.kind === "run") return BarChart3;
  if (tab.kind === "file") return fileIcon(tab.fileType);
  return sectionIcon(tab.section);
}

function label(tab: TabEntry): string {
  if (tab.kind === "section") {
    return tab.section.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
  return tab.title;
}

function close(id: string, event: Event) {
  event.stopPropagation();
  tabs.closeTab(id);
}

function onAuxClick(id: string, event: MouseEvent) {
  // Middle click closes, as it does in every editor and browser.
  if (event.button === 1) {
    event.preventDefault();
    tabs.closeTab(id);
  }
}
</script>

<template>
  <div
    v-if="tabs.ordered.length"
    data-testid="tab-strip"
    class="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border bg-panel"
  >
    <button
      v-for="tab in tabs.ordered"
      :key="tab.id"
      type="button"
      :data-testid="`tab-${tab.kind}`"
      :data-active="tab.id === tabs.activeId || undefined"
      :title="tab.kind === 'entry' ? `${tab.entryName} · ${tab.section}` : tab.title"
      class="group relative inline-flex shrink-0 select-none items-center gap-1.5 whitespace-nowrap border-r border-border-subtle px-3 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground data-[active]:bg-surface data-[active]:text-foreground data-[active]:after:absolute data-[active]:after:inset-x-0 data-[active]:after:-bottom-px data-[active]:after:h-0.5 data-[active]:after:bg-primary"
      @click="tabs.activate(tab.id)"
      @auxclick="onAuxClick(tab.id, $event)"
    >
      <component
        :is="iconFor(tab)"
        class="size-3.5 shrink-0"
        :stroke-width="ICON_STROKE_WIDTH"
      />
      <span class="max-w-40 truncate">{{ label(tab) }}</span>
      <span
        v-if="tab.kind === 'entry'"
        class="text-2xs text-text-faint"
      >· {{ tab.section }}</span>

      <!-- The dot takes the close button's place until hovered, so the tab does
           not change width and the row does not shuffle under the cursor. -->
      <span
        v-if="tab.isDirty"
        class="size-1.5 shrink-0 rounded-full bg-primary group-hover:hidden"
        title="Unsaved changes"
      />
      <span
        class="-mr-1 grid size-4 shrink-0 place-items-center rounded-xs text-text-faint opacity-0 hover:bg-active hover:text-foreground group-hover:opacity-100"
        :class="tab.isDirty ? 'hidden group-hover:grid' : ''"
        role="button"
        aria-label="Close tab"
        @click="close(tab.id, $event)"
      >
        <X class="size-3" :stroke-width="2.5" />
      </span>
    </button>
  </div>
</template>
