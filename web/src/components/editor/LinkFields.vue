<script setup lang="ts">
/**
 * One transmission technology's form.
 *
 * Extracted for the same reason as `NodeFields`: the links editor shows it both
 * in its list and under the map, for whichever link was clicked there.
 *
 * `template` and `active` are here now, which they were not in the list-only
 * version. The map's add-link flow sets a template — that is what makes a new
 * link a usable technology rather than a bare `base_tech: transmission` — so it
 * has to be visible and changeable afterwards.
 *
 * Which template, and what it supplies, used to be a sentence at the bottom
 * naming only `base_tech`. It is now on the fields themselves, like every other
 * editor: a link inheriting `flow_cap_max` and `cost_flow_cap` from
 * `power_lines` says so where those values would go.
 */
import { computed } from "vue";

import ParamRows from "./ParamRows.vue";
import FieldRow from "@/components/app/FieldRow.vue";
import { Switch } from "@/components/ui/switch";
import { FIELD } from "@/lib/formClasses";

import type { LinkEntry } from "@/lib/entries";
import { collectInherited, linkSetsKey } from "@/lib/inherited";

const props = defineProps<{
  entry: LinkEntry;
  /** Every template in the model, for showing what this link inherits. */
  templates: Record<string, Record<string, any>>;
}>();

/**
 * The `<datalist>` elements the two endpoint fields and the template field point
 * at are rendered once by the parent, not here: this form appears once per link
 * in the list, and a datalist repeated per row would be the same id many times
 * over.
 */

const emit = defineEmits<{ change: [] }>();

function onChange() {
  emit("change");
}

/**
 * Keys the form has a field for. `base_tech` is in the list without being a
 * field: being a link *is* its `base_tech`, so a ghost row offering to set it
 * would invite someone to break the link.
 */
const PROMOTED = ["template", "active", "link_from", "link_to", "base_tech"];

const inherited = computed(() =>
  collectInherited(
    props.entry.template,
    props.entry.template ? props.templates[props.entry.template] : undefined,
    undefined,
  ),
);

function sets(key: string): boolean {
  return linkSetsKey(props.entry, key);
}
</script>

<template>
  <div class="flex flex-col gap-2 pb-2">
    <FieldRow label="name" width="short">
      <input
        v-model="entry.name"
        type="text"
        data-testid="link-name"
        :class="FIELD"
        @input="onChange"
      />
    </FieldRow>

    <!-- The endpoints, which are what make this a link. Free text with
         suggestions rather than a closed list: a link may name a node defined in
         a file this editor has not loaded. -->
    <FieldRow
      label="link_from"
      width="short"
      :inherited="inherited.link_from ?? null"
      :is-set="sets('link_from')"
      @revert="
        entry.linkFrom = '';
        onChange();
      "
    >
      <input
        v-model="entry.linkFrom"
        type="text"
        list="link-node-names"
        placeholder="node"
        data-testid="link-from"
        :class="FIELD"
        @change="onChange"
      />
    </FieldRow>

    <FieldRow
      label="link_to"
      width="short"
      :inherited="inherited.link_to ?? null"
      :is-set="sets('link_to')"
      @revert="
        entry.linkTo = '';
        onChange();
      "
    >
      <input
        v-model="entry.linkTo"
        type="text"
        list="link-node-names"
        placeholder="node"
        data-testid="link-to"
        :class="FIELD"
        @change="onChange"
      />
    </FieldRow>

    <FieldRow label="template" width="short">
      <input
        :value="entry.template ?? ''"
        type="text"
        list="link-template-names"
        placeholder="(none)"
        data-testid="link-template"
        :class="FIELD"
        @change="
          entry.template = ($event.target as HTMLInputElement).value || null;
          onChange();
        "
      />
    </FieldRow>

    <FieldRow
      label="active"
      width="auto"
      :inherited="inherited.active ?? null"
      :is-set="sets('active')"
      @revert="
        entry.active = true;
        onChange();
      "
    >
      <Switch v-model="entry.active" @update:model-value="onChange" />
    </FieldRow>

    <ParamRows
      :params="entry.params"
      :inherited="inherited"
      :promoted="PROMOTED"
      @change="onChange"
    />
  </div>
</template>
