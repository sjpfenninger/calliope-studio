<script setup lang="ts">
/**
 * The one tab bar, shared by editors and runs.
 *
 * Deliberately hand-rolled rather than built on a Tabs primitive: close buttons,
 * dirty dots, overflow scrolling and middle-click-to-close do not fit a
 * `TabsList`, and its roving tabindex fights all of them.
 *
 * 32px tall. The active tab is the *same surface as the editor below it*, with
 * the strip's bottom hairline stopping at its two side edges, so the two read as
 * one continuous sheet and the inactive tabs sit back on the strip. Those edges
 * are the separator it carries and the one belonging to the tab before it, both
 * raised to full strength. Its label and icon are accent-coloured; there is no
 * underline. All of that comes from components/app/segmented.ts, which is the
 * point — this is the one hand-rolled strip in the app, and importing the classes
 * is what stops it drifting.
 *
 * It scrolls with no scrollbar: the global one is 10px, a third of the strip's
 * height, drawn straight across the tabs. The wheel and the auto-reveal below
 * are what replace it.
 *
 * Scrolling is also why the hairline is an inset shadow and not a `border-b`.
 * `overflow-x: auto` computes `overflow-y` to `auto` too, and the clip is at the
 * padding box — so the `-bottom-px` bridge every other strip erases its border
 * with was drawn outside the clip and thrown away, and this bar showed a full
 * line under the active tab for its whole existence. The line has to be inside
 * the box for the tab's own background to cover it; see
 * `SEGMENT_STRIP_LINE_SCROLLED`. The bridge is still in the shared class and is
 * simply inert here.
 */
import { ref, watch } from "vue";
import { BarChart3, ShieldCheck } from "@lucide/vue";
import { X } from "@lucide/vue";

import {
  SEGMENT_BASE,
  SEGMENT_NAV_ACTIVE,
  SEGMENT_NAV_EDGES_RULED,
  SEGMENT_NAV_SEAM,
  SEGMENT_STRIP_LINE_SCROLLED,
} from "@/components/app/segmented";
import { fileIcon, ICON_STROKE_WIDTH_TIGHT, sectionIcon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useTabsStore, type TabEntry } from "@/stores/tabs";

const tabs = useTabsStore();

/** The shared segment shape, plus the few things only a document tab needs. */
const TAB_CLASS = cn(
  SEGMENT_BASE,
  SEGMENT_NAV_ACTIVE,
  SEGMENT_NAV_SEAM.surface,
  SEGMENT_NAV_EDGES_RULED,
  "px-3 data-[preview]:italic hover:bg-hover",
);

const strip = ref<HTMLElement | null>(null);

function onWheel(event: WheelEvent) {
  const el = strip.value;
  if (!el || el.scrollWidth <= el.clientWidth) return;
  // A vertical wheel — which is all a mouse has — is the only way to reach a
  // tab that is off the end. A trackpad's horizontal delta already works, so it
  // is left alone.
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  el.scrollLeft += event.deltaY;
}

// `post`, so the tab exists in the DOM by the time we look for it — activating
// something can be what created it.
watch(
  () => tabs.activeId,
  () => {
    strip.value
      ?.querySelector("[data-active]")
      // `block: "nearest"` matters: without it the whole shell scrolls.
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  },
  { flush: "post" },
);

// The fallthrough reads `tab.section`, so every kind without one has to be
// handled before it or it resolves `sectionIcon(undefined)`.
function iconFor(tab: TabEntry) {
  if (tab.kind === "run") return BarChart3;
  if (tab.kind === "validation") return ShieldCheck;
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
  <!-- design-check: allow strip — the one hand-rolled strip. Close buttons,
       dirty dots, preview italics, middle-click and overflow auto-reveal do not
       fit PanelHeader's slot, but the active-state classes below are imported
       from segmented.ts so the one selection rule still cannot drift.
       design-check: allow strip -->
  <div
    v-if="tabs.ordered.length"
    ref="strip"
    data-testid="tab-strip"
    :class="
      cn(
        'scrollbar-none flex h-8 shrink-0 items-stretch overflow-x-auto bg-panel',
        SEGMENT_STRIP_LINE_SCROLLED,
      )
    "
    @wheel="onWheel"
  >
    <button
      v-for="tab in tabs.ordered"
      :key="tab.id"
      type="button"
      :data-testid="`tab-${tab.kind}`"
      :data-active="tab.id === tabs.activeId || undefined"
      :data-preview="tab.id === tabs.previewId || undefined"
      :title="tab.kind === 'entry' ? `${tab.entryName} · ${tab.section}` : tab.title"
      :class="TAB_CLASS"
      @click="tabs.activate(tab.id)"
      @dblclick="tabs.promote(tab.id)"
      @auxclick="onAuxClick(tab.id, $event)"
    >
      <component
        :is="iconFor(tab)"
        class="size-3.5 shrink-0"
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
        data-testid="tab-dirty"
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
        <X class="size-3" :stroke-width="ICON_STROKE_WIDTH_TIGHT" />
      </span>
    </button>
  </div>
</template>
