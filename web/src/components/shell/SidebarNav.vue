<script setup lang="ts">
/**
 * The three top-level sections: Model, Files, Runs.
 *
 * These are routes rather than component state, so the section is bookmarkable
 * and the back button undoes it. They are children of one `AppShell` record, so
 * switching between them does not remount the shell — the tab bar, Monaco's
 * models and any live run pane all survive.
 *
 * Drawn as one segmented control rather than three links: as a plain stack it
 * read as website nav, and nothing said that these three choose what the panel
 * underneath shows. One bordered box with divided segments, a filled active one
 * and a 2px bar along its bottom edge does say it — the bar points at what it
 * controls.
 *
 * Horizontal, because the sidebar is 22% of the window by default and three
 * labels need about 210px of that. The segments grow from their content rather
 * than being equal thirds — equal thirds truncate "Model" to "Mo…" in a 225px
 * sidebar while leaving slack in the two shorter ones. Dragged to the 14%
 * minimum the labels do truncate, and the icons carry the meaning.
 */
import { computed } from "vue";
import { useRoute } from "vue-router";
import { BarChart3, FileCode2, Folder } from "lucide-vue-next";

import { ICON_STROKE_WIDTH } from "@/lib/icons";
import { useValidationStore } from "@/stores/validation";

const route = useRoute();

const props = defineProps<{
  projectId: string | null;
  versionId: string | null;
  /** Results-only mode has no model definition, so two sections are unavailable. */
  editable: boolean;
}>();

const validation = useValidationStore();

const items = computed(() => [
  {
    name: "model" as const,
    label: "Model",
    icon: FileCode2,
    enabled: props.editable,
    // Visible from any section, so a validation error is not hidden behind a
    // section the user is not currently looking at.
    count: validation.errors.length || null,
  },
  { name: "files" as const, label: "Files", icon: Folder, enabled: props.editable, count: null },
  { name: "runs" as const, label: "Runs", icon: BarChart3, enabled: true, count: null },
]);

function target(name: string) {
  // The query has to be carried across explicitly. A `to` object without one
  // drops it, which would throw away `?tab=` on every section change — so the
  // tab in front would vanish from the URL and a link copied afterwards would
  // restore nothing.
  const query = route.query;
  return props.versionId
    ? {
        name,
        params: { projectId: props.projectId, versionId: props.versionId },
        query,
      }
    : { name: "viewer", query };
}
</script>

<template>
  <!-- The padding is on the outer element, so the section divider the shell
       draws underneath still spans the full width of the sidebar. -->
  <div class="p-1.5">
    <nav
      class="flex divide-x divide-border-subtle overflow-hidden rounded-sm border border-border bg-surface"
      role="group"
    >
      <component
        :is="item.enabled ? 'RouterLink' : 'span'"
        v-for="item in items"
        :key="item.name"
        :to="item.enabled ? target(item.name) : undefined"
        :data-testid="`nav-${item.name}`"
        :title="item.enabled ? undefined : 'Not available for a results file'"
        class="group relative flex h-7 min-w-0 flex-auto items-center justify-center gap-1.5 px-1.5 text-sm text-text-dim transition-colors"
        :class="
          item.enabled
            ? 'hover:bg-hover hover:text-foreground'
            : 'cursor-default text-text-faint'
        "
        active-class="!bg-accent-soft !text-accent-text font-medium"
      >
        <component
          :is="item.icon"
          class="size-3.5 shrink-0 text-text-faint group-[.router-link-active]:text-primary"
          :stroke-width="ICON_STROKE_WIDTH"
        />
        <span class="truncate">{{ item.label }}</span>
        <span
          v-if="item.count"
          class="shrink-0 rounded-xs bg-danger-soft px-1 text-2xs font-medium tabular-nums text-danger-text"
        >
          {{ item.count }}
        </span>
        <span
          class="absolute inset-x-0 bottom-0 h-0.5 bg-primary opacity-0 transition-opacity group-[.router-link-active]:opacity-100"
        />
      </component>
    </nav>
  </div>
</template>
