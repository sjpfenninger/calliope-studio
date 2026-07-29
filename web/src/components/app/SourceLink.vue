<script setup lang="ts">
/**
 * Where an inherited value comes from, named and clickable.
 *
 * The marker beside a field used to show a bare name, and a name alone cannot say
 * whether it is a template or a data table — a table may be called anything, the
 * name of the parameter it supplies included, so `flow_cap_max ↳ flow_cap_max` was
 * a thing this app really printed. The kind is now spelled out.
 *
 * It also used to be a dead end. The source is precisely what you want to look at
 * next, so it opens: a data table in its own entry tab, a template in the file that
 * declares it, at the line that declares it.
 *
 * It reaches for the two stores itself rather than emitting. The alternative was
 * threading a handler through `ParamRows`, `NodeFields` and `LinkFields` to four
 * editors for one click — and `ConfirmDialog` already sets the precedent that a
 * composition component may know about a store.
 */
import { computed } from "vue";

import { INLINE_LINK } from "@/lib/formClasses";
import { openIntent } from "@/lib/openIntent";
import { resolveSource } from "@/lib/sourceTargets";
import type { InheritedSource } from "@/lib/inherited";
import { useComponentTreeStore } from "@/stores/componentTree";
import { useTabsStore } from "@/stores/tabs";

const props = defineProps<{ source: InheritedSource }>();

const componentTree = useComponentTreeStore();
const tabs = useTabsStore();

/** The kind, as the model's own vocabulary spells it. */
const label = computed(() => `${props.source.name} (${props.source.kind})`);

const target = computed(() => resolveSource(componentTree.tree, props.source));

function open(event: MouseEvent) {
  const found = target.value;
  if (!found) return;
  const intent = openIntent(event);

  // A data table has a structured editor and is addressed by name; a template has
  // none, so it opens as raw YAML and the line is the only thing that makes that
  // useful in a file of forty of them.
  if (found.section === "data_tables") {
    tabs.openEntry("data_tables", found.file, found.name, intent);
  } else if (found.line != null) {
    tabs.jumpTo(found.file, found.line, 1, intent);
  } else {
    tabs.openFile(found.file, intent);
  }
}
</script>

<template>
  <!-- Unresolvable is the ordinary state of a model mid-edit, so it degrades to
       the plain text it was before rather than to a link that goes nowhere. -->
  <button
    v-if="target"
    type="button"
    data-testid="source-link"
    :class="INLINE_LINK"
    @click="open"
  >
    {{ label }}
  </button>
  <span v-else>{{ label }}</span>
</template>
