<script setup lang="ts">
/**
 * One node's form.
 *
 * A component rather than a block of template, because the nodes editor now shows
 * it in two places: inside the list's accordion, and under the map for whichever
 * node is selected there. Two copies of a form that writes to someone's model
 * file is exactly the sort of duplication `lib/entries.ts` exists to avoid.
 *
 * It owns no loading and no saving — it edits the `NodeEntry` it is handed and
 * says so by emitting `change`.
 *
 * What a template or a data table supplies appears *on the field it would fill*,
 * not in a table underneath: a node whose coordinates come from a CSV shows them
 * as ghost text in the latitude and longitude fields, and dragging it on the map
 * turns them into its own with the inherited pair still visible, struck through,
 * beside a button that puts them back.
 */
import { computed, ref } from "vue";
import { Plus, X } from "@lucide/vue";

import ParamRows from "./ParamRows.vue";
import FieldRow from "@/components/app/FieldRow.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import { Switch } from "@/components/ui/switch";
import Eyebrow from "@/components/app/Eyebrow.vue";
import { FIELD, SECTION } from "@/lib/formClasses";
import { focusNextFrame, useFocusNew } from "./focusNew";

import { rowKey, type NodeEntry } from "@/lib/entries";
import { collectInherited, nodeSetsKey } from "@/lib/inherited";
import type { DataTableParam } from "@/lib/dataTableParams";

export type { DataTableParam };

const props = defineProps<{
  entry: NodeEntry;
  /** Every template in the model, for showing what this node inherits. */
  templates: Record<string, Record<string, any>>;
  /** This node's data-table parameters, by parameter name. */
  dataTableParams: Record<string, DataTableParam>;
}>();

const emit = defineEmits<{ change: [] }>();

function onChange() {
  emit("change");
}

const nameField = ref<HTMLInputElement | null>(null);
/** For the editor that just added this node; see `focusNew`. */
defineExpose({ focusName: () => focusNextFrame(nameField.value) });

/** The name of a technology just added below takes the cursor. */
const focus = useFocusNew();

/** Keys the form has a field for, so they get no ghost parameter row. */
const PROMOTED = ["template", "active", "latitude", "longitude", "techs"];

const inherited = computed(() =>
  collectInherited(
    props.entry.template,
    props.entry.template ? props.templates[props.entry.template] : undefined,
    props.dataTableParams,
  ),
);

function sets(key: string): boolean {
  return nodeSetsKey(props.entry, key);
}

/** A coordinate field writes a number, or null — never the DOM's string. */
function setCoordinate(key: "latitude" | "longitude", raw: string) {
  const trimmed = raw.trim();
  props.entry[key] = trimmed === "" ? null : Number(trimmed);
  onChange();
}

function addTech() {
  props.entry.techs.push({ techName: "", params: [] });
  focus.request(rowKey(props.entry.techs[props.entry.techs.length - 1]));
  onChange();
}

function removeTech(index: number) {
  props.entry.techs.splice(index, 1);
  onChange();
}
</script>

<template>
  <div class="flex flex-col gap-2 pb-2">
    <FieldRow label="name" width="short">
      <input
        ref="nameField"
        v-model="entry.name"
        type="text"
        data-testid="node-name"
        :class="FIELD"
        @input="onChange"
      />
    </FieldRow>

    <FieldRow label="template" width="short">
      <input
        :value="entry.template ?? ''"
        type="text"
        placeholder="(none)"
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

    <FieldRow
      label="latitude"
      width="num"
      :inherited="inherited.latitude ?? null"
      :is-set="sets('latitude')"
      @revert="
        entry.latitude = null;
        onChange();
      "
      #default="{ placeholder }"
    >
      <input
        :value="entry.latitude ?? ''"
        type="number"
        step="any"
        min="-90"
        max="90"
        :placeholder="placeholder"
        data-testid="node-latitude"
        :class="FIELD"
        @change="setCoordinate('latitude', ($event.target as HTMLInputElement).value)"
      />
    </FieldRow>

    <FieldRow
      label="longitude"
      width="num"
      :inherited="inherited.longitude ?? null"
      :is-set="sets('longitude')"
      @revert="
        entry.longitude = null;
        onChange();
      "
      #default="{ placeholder }"
    >
      <input
        :value="entry.longitude ?? ''"
        type="number"
        step="any"
        min="-180"
        max="180"
        :placeholder="placeholder"
        data-testid="node-longitude"
        :class="FIELD"
        @change="setCoordinate('longitude', ($event.target as HTMLInputElement).value)"
      />
    </FieldRow>

    <ParamRows
      :params="entry.extraParams"
      :inherited="inherited"
      :promoted="PROMOTED"
      @change="onChange"
    />

    <!-- Per-node technology overrides: the same tech, tuned here. -->
    <div :class="SECTION">
      <div class="flex items-center justify-between">
        <Eyebrow>techs</Eyebrow>
        <TooltipButton label="Add a technology" :icon="Plus" size="xs" @click="addTech" />
      </div>

      <!-- Keyed by identity: removing one used to hand the next one's name to
           a component still holding the removed one's parameter drafts. -->
      <div
        v-for="(techOvr, ti) in entry.techs"
        :key="rowKey(techOvr)"
        class="flex flex-col gap-1 border-t border-border-subtle pt-1.5 first:border-t-0 first:pt-0"
      >
        <FieldRow :label="techOvr.techName">
          <template #label>
            <input
              v-model="techOvr.techName"
              type="text"
              placeholder="technology name"
              :ref="(el) => focus.bind(el, rowKey(techOvr))"
              :class="FIELD"
              @input="onChange"
            />
          </template>
          <template #action>
            <TooltipButton
              label="Remove this technology"
              :icon="X"
              tone="danger"
              size="xs"
              @click="removeTech(ti)"
            />
          </template>
        </FieldRow>

        <ParamRows
          :params="techOvr.params"
          add-label="Add override"
          @change="onChange"
        />
      </div>

      <StateMessage v-if="!entry.techs.length" variant="note">
        No technologies assigned.
      </StateMessage>
    </div>
  </div>
</template>
