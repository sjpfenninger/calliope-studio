<script setup lang="ts">
/**
 * The three top-level sections: Model, Files, Runs.
 *
 * These are routes rather than component state, so the section is bookmarkable
 * and the back button undoes it. They are children of one `AppShell` record, so
 * switching between them does not remount the shell — the tab bar, Monaco's
 * models and any live run pane all survive.
 *
 * The 2px inset bar on the active item is the detail that makes this read as a
 * console rather than a website nav.
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
  <nav class="flex flex-col gap-px px-1.5 py-1">
    <component
      :is="item.enabled ? 'RouterLink' : 'span'"
      v-for="item in items"
      :key="item.name"
      :to="item.enabled ? target(item.name) : undefined"
      :data-testid="`nav-${item.name}`"
      :title="item.enabled ? undefined : 'Not available for a results file'"
      class="group relative flex h-6 items-center gap-2 rounded-sm px-2 text-sm text-text-dim transition-colors"
      :class="
        item.enabled
          ? 'hover:bg-hover hover:text-foreground'
          : 'cursor-default text-text-faint'
      "
      active-class="!bg-accent-soft !text-accent-text font-medium"
    >
      <span
        class="absolute left-0 top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary opacity-0 transition-opacity group-[.router-link-active]:opacity-100"
      />
      <component
        :is="item.icon"
        class="size-3.5 shrink-0 text-text-faint group-[.router-link-active]:text-primary"
        :stroke-width="ICON_STROKE_WIDTH"
      />
      <span class="truncate">{{ item.label }}</span>
      <span
        v-if="item.count"
        class="ml-auto rounded-xs bg-danger-soft px-1 text-2xs font-medium tabular-nums text-danger-text"
      >
        {{ item.count }}
      </span>
    </component>
  </nav>
</template>
