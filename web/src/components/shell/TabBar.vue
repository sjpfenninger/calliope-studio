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
 * Tabs are dragged into whatever order the user wants; see "Reordering" below.
 * The order lives in the store, since it is what `persist` writes.
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
import { computed, nextTick, ref, watch } from "vue";
import { BarChart3, ShieldCheck } from "@lucide/vue";
import { X } from "@lucide/vue";

import {
  SEGMENT_BASE,
  SEGMENT_NAV_ACTIVE,
  SEGMENT_NAV_EDGE_LEAD,
  SEGMENT_NAV_EDGES_RULED,
  SEGMENT_NAV_SEAM,
  SEGMENT_STRIP_LINE_SCROLLED,
} from "@/components/app/segmented";
import TabHistory from "./TabHistory.vue";
import { ICON_BUTTON_XS } from "@/lib/formClasses";
import { fileIcon, ICON_STROKE_WIDTH_TIGHT, MathIcon, sectionIcon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useConfirmStore } from "@/stores/confirm";
import { useTabsStore, type TabEntry } from "@/stores/tabs";

const tabs = useTabsStore();

/** The shared segment shape, plus the few things only a document tab needs. */
const TAB_CLASS = cn(
  SEGMENT_BASE,
  SEGMENT_NAV_ACTIVE,
  SEGMENT_NAV_SEAM.surface,
  SEGMENT_NAV_EDGES_RULED,
  // No hover background: every other segmented strip marks hover with text
  // alone, and this was the one that also painted the segment.
  "px-3 data-[preview]:italic data-[dragging]:opacity-40",
);

/**
 * The close glyph. Shown only while its tab is hovered or focused, and focusable
 * in its own right: it is `role="button"`, and a button a keyboard cannot reach
 * is a claim the markup makes and the page does not keep.
 */
const CLOSE_CLASS = cn(
  ICON_BUTTON_XS,
  "-mr-1 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 focus-visible:opacity-100",
);

const strip = ref<HTMLElement | null>(null);

/** The well's separator follows the same rule a tab's does; see segmented.ts. */
const leadsActive = computed(() => tabs.ordered[0]?.id === tabs.activeId);

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

/** Brings a tab that is off the end of the scroller back into it. */
function reveal(selector: string) {
  strip.value
    ?.querySelector(selector)
    // `block: "nearest"` matters: without it the whole shell scrolls.
    ?.scrollIntoView({ inline: "nearest", block: "nearest" });
}

// `post`, so the tab exists in the DOM by the time we look for it — activating
// something can be what created it.
watch(() => tabs.activeId, () => reveal("[data-active]"), { flush: "post" });

// ── Reordering ──────────────────────────────────────────────────────────────
//
// HTML5 drag-and-drop rather than pointer capture: the drag image, the cursor,
// the auto-cancel on Escape and the distinction between a click and a drag all
// come from the browser, and the tab is already `select-none`. The reorder is
// applied *as the drag moves*, so `drop` has nothing left to do — and nothing is
// restored on a cancel, which is deliberate rather than missing: the tab is
// where the pointer last put it, which is what every editor does and what the
// live preview has been showing all along.

const draggingId = ref<string | null>(null);

/**
 * The payload's type, and the reason it is not `text/plain`.
 *
 * Firefox will not start a drag with no data at all, but *what* is offered
 * decides who will take it: a `text/plain` tab is a valid drop into Monaco, so
 * releasing one over the editor would paste the tab's id into the user's file. A
 * private type nothing else reads keeps the drag inside this strip.
 */
const DRAG_TYPE = "application/x-calliope-tab";

function onDragStart(id: string, event: DragEvent) {
  if (!event.dataTransfer) return;
  draggingId.value = id;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(DRAG_TYPE, id);
  // Choosing where a tab sits is intent to keep it. Left in the preview slot it
  // would be evicted by the next click in the tree, taking the position with it.
  tabs.promote(id);
}

function onDragOver(id: string, event: DragEvent) {
  const held = draggingId.value;
  // Not our drag — a file from the desktop, say. Leave it to whatever wants it.
  if (!held || !event.dataTransfer) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  if (id === held) return;

  const from = tabs.ordered.findIndex((tab) => tab.id === held);
  const to = tabs.ordered.findIndex((tab) => tab.id === id);
  if (from < 0 || to < 0) return;

  // Only once the pointer is past the target's midpoint, and only in the
  // direction of travel. Moving on entry alone oscillates between two tabs of
  // unequal widths: the move puts the dragged tab under a pointer still inside
  // the tab it displaced, which hands it straight back.
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const middle = box.left + box.width / 2;
  if (from < to ? event.clientX < middle : event.clientX > middle) return;

  tabs.moveTab(held, to);
  // The same auto-reveal an activation gets. The strip does not scroll from the
  // pointer resting at its edge, so without this a tab dragged towards the end
  // of an overflowing bar walks out of sight.
  nextTick(() => reveal("[data-dragging]"));
}

function onDragEnd() {
  draggingId.value = null;
}

// The fallthrough reads `tab.section`, so every kind without one has to be
// handled before it or it resolves `sectionIcon(undefined)`.
function iconFor(tab: TabEntry) {
  if (tab.kind === "run") return BarChart3;
  if (tab.kind === "validation") return ShieldCheck;
  if (tab.kind === "math") return MathIcon;
  if (tab.kind === "file") return fileIcon(tab.fileType);
  return sectionIcon(tab.section);
}

function label(tab: TabEntry): string {
  if (tab.kind === "section") {
    return tab.section.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
  return tab.title;
}

/**
 * The unclipped label, plus the one thing the label cannot say.
 *
 * A section tab is `(section, filePath)` and reads as just "Techs", so a model
 * defining `techs:` in two files gives two tabs that are identical on screen and
 * edit different halves of the model. The file was already here for entry tabs
 * and nowhere for section tabs, which is the pair that needed it most.
 *
 * The *visible* label is deliberately left alone: a file suffix on every section
 * tab is noise for the single-file models that are most of them, and
 * `EditorToolbar` answers it unconditionally one row below.
 */
function titleFor(tab: TabEntry): string {
  if (tab.kind === "section") return `${label(tab)} — ${tab.filePath}`;
  if (tab.kind === "entry") {
    return `${tab.entryName} · ${tab.section} — ${tab.filePath}`;
  }
  return tab.title;
}

/**
 * Closing a dirty tab asks first — the same dialog the route guard uses, on
 * the same grounds: the buffer is the only copy of the edits, so closing it
 * discards them with the file on disk untouched.
 *
 * The guard lives here rather than in `closeTab` because the store is also
 * called from non-interactive paths — preview eviction already skips dirty
 * tabs on its own — and a store that awaits a dialog would hang them.
 */
async function closeGuarded(id: string) {
  if (tabs.get(id)?.isDirty) {
    const ok = await useConfirmStore().ask({
      title: "Close tab with unsaved changes?",
      message:
        "Edits you have not saved will be lost. The file on disk is untouched.",
      confirmLabel: "Close tab",
      destructive: true,
    });
    if (!ok) return;
  }
  tabs.closeTab(id);
}

function close(id: string, event: Event) {
  event.stopPropagation();
  void closeGuarded(id);
}

function onAuxClick(id: string, event: MouseEvent) {
  // Middle click closes, as it does in every editor and browser.
  if (event.button === 1) {
    event.preventDefault();
    void closeGuarded(id);
  }
}

/**
 * Delete or Backspace on the focused tab closes it.
 *
 * The close glyph is a tab stop of its own, but this is the faster path from
 * the tab itself, and it predates the glyph being reachable at all. Both keys,
 * because which one "delete" means is a keyboard-layout question the user
 * should not have to answer.
 */
function onKeydown(id: string, event: KeyboardEvent) {
  if (event.key !== "Delete" && event.key !== "Backspace") return;
  event.preventDefault();
  void closeGuarded(id);
}

/** Enter or Space on the focused close glyph, which is what `role="button"` promises. */
function onCloseKeydown(id: string, event: KeyboardEvent) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  close(id, event);
}
</script>

<template>
  <!-- The row is the strip; the tabs scroll *within* it, so back and forward
       stay put rather than sliding off the left end with the first tab.

       Both halves draw the bottom hairline with the same inset shadow. Two
       mechanisms — a `border-b` here and a shadow there — would be two ways of
       painting one pixel, and that is how they come to disagree by one.

       design-check: allow strip — the one hand-rolled strip. Close buttons,
       dirty dots, preview italics, middle-click and overflow auto-reveal do not
       fit PanelHeader's slot, but the active-state classes below are imported
       from segmented.ts so the one selection rule still cannot drift.
       design-check: allow strip -->
  <div
    v-if="tabs.ordered.length"
    class="flex h-8 shrink-0 items-stretch bg-panel"
  >
    <!-- The well carries the separator the first tab cannot: a tab's rule is its
         own `border-r`, so the left end of a ruled strip has none, and the tabs
         scroll, so one owned by the first tab would slide out of the strip. -->
    <div
      data-testid="tab-lead"
      :data-next-active="leadsActive || undefined"
      :class="
        cn(
          'flex items-center gap-0.5 px-1',
          SEGMENT_NAV_EDGE_LEAD,
          SEGMENT_STRIP_LINE_SCROLLED,
        )
      "
    >
      <TabHistory />
    </div>

    <!-- `min-w-0` is load-bearing: a flex child will not shrink below its
         content without it, so the tabs would push the buttons off. -->
    <div
      ref="strip"
      data-testid="tab-strip"
      :class="
        cn(
          'scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto',
          SEGMENT_STRIP_LINE_SCROLLED,
        )
      "
      @wheel="onWheel"
    >
      <!-- design-check: allow native-title — the tab's own label, which is
           `max-w-40 truncate`; a tooltip here would be a portal per tab. -->
      <!-- `:key` is the tab's id and that is load-bearing for the drag: Vue moves
           the very element the pointer is holding rather than rebuilding the row,
           and a drag whose source element is replaced mid-flight is cancelled. -->
      <button
        v-for="tab in tabs.ordered"
        :key="tab.id"
        type="button"
        draggable="true"
        :data-testid="`tab-${tab.kind}`"
        :data-tab-id="tab.id"
        :data-active="tab.id === tabs.activeId || undefined"
        :data-preview="tab.id === tabs.previewId || undefined"
        :data-dragging="tab.id === draggingId || undefined"
        :title="titleFor(tab)"
        :class="TAB_CLASS"
        @click="tabs.activate(tab.id)"
        @keydown="onKeydown(tab.id, $event)"
        @dblclick="tabs.promote(tab.id)"
        @auxclick="onAuxClick(tab.id, $event)"
        @dragstart="onDragStart(tab.id, $event)"
        @dragover="onDragOver(tab.id, $event)"
        @drop.prevent="onDragEnd"
        @dragend="onDragEnd"
      >
        <component
          :is="iconFor(tab)"
          class="size-3.5 shrink-0"
        />
        <span class="max-w-40 truncate">{{ label(tab) }}</span>
        <span
          v-if="tab.kind === 'entry'"
          class="text-2xs text-text-muted"
        >· {{ tab.section }}</span>

        <!-- The dot takes the close button's place until hovered, so the tab
             does not change width and the row does not shuffle under the
             cursor.

             Which is also why it gets no tooltip: it is gone by the time a
             pointer could rest on it, so the `title` it used to carry was
             unreachable. The sr-only text is the part that was doing real work
             — it joins the tab's own accessible name. -->
        <span
          v-if="tab.isDirty"
          data-testid="tab-dirty"
          class="size-1.5 shrink-0 rounded-full bg-primary group-hover:hidden group-focus-visible:hidden"
        >
          <span class="sr-only">Unsaved changes</span>
        </span>
        <!-- `group-focus-visible` as well as `group-hover`: keyboard focus is the
             other way a tab is singled out, and Delete only reads as available
             if the glyph it maps onto is on screen. -->
        <span
          :class="cn(CLOSE_CLASS, tab.isDirty && 'hidden group-hover:grid group-focus-visible:grid')"
          role="button"
          tabindex="0"
          aria-label="Close tab"
          @click="close(tab.id, $event)"
          @keydown="onCloseKeydown(tab.id, $event)"
        >
          <X class="size-3" :stroke-width="ICON_STROKE_WIDTH_TIGHT" />
        </span>
      </button>
    </div>
  </div>
</template>
