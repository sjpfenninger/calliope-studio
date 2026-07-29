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
 * underneath shows. Being *continuous* with that panel says it — the active
 * segment is the same colour as the section beneath it and has no line between
 * them, while the other two sit on a recessed strip.
 *
 * `edges` is the rest of that shape. Unlike the tab bar, this strip draws no
 * rules between its segments, so the fill was the only thing marking where the
 * active one ended and the seam had nothing to descend from; with the two side
 * borders it is a tab opening into the section rather than a tinted word.
 *
 * It used to carry a soft accent fill, a hand-rolled underline span, and the
 * codebase's only two `!important` utilities, all at once. See
 * components/app/segmented.ts for the one rule that replaced them.
 *
 * Horizontal, because the sidebar is 22% of the window by default and three
 * labels need about 210px of that. The segments grow from their content rather
 * than being equal thirds — equal thirds truncate "Model" to "Mo…" in a 225px
 * sidebar while leaving slack in the two shorter ones. Dragged to the 14%
 * minimum the labels do truncate, and the icons carry the meaning.
 */
import { computed } from "vue";
import { useRoute } from "vue-router";
import { BarChart3, FileCode2, Folder } from "@lucide/vue";

import Segmented from "@/components/app/Segmented.vue";
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
    count: validation.problems.length || null,
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

/** The nav as segments; `to` is what makes each one a RouterLink. */
const segments = computed(() =>
  items.value.map((item) => ({
    value: item.name,
    label: item.label,
    icon: item.icon,
    badge: item.count || undefined,
    disabled: !item.enabled,
    tip: item.enabled ? undefined : "Not available for a results file",
    to: item.enabled ? target(item.name) : undefined,
    testid: `nav-${item.name}`,
  })),
);

/** Which segment the route is on. RouterLink paints its own active state, but
 *  `Segmented` keys the bar off `data-active`, so it has to be told. */
const active = computed(() =>
  items.value.find((item) => route.name === item.name)?.name,
);
</script>

<template>
  <!-- Full-bleed, and recessed relative to the sidebar it sits in, so the active
       segment can open straight into the section below it. `bg-background` is a
       step *back* from `--cg-panel` in both themes, which is what makes the same
       two classes read correctly in light and dark. -->
  <Segmented
    :model-value="active"
    :items="segments"
    mode="nav"
    seam="panel"
    size="md"
    fill
    edges
    class="border-b border-border bg-background"
  />
</template>
