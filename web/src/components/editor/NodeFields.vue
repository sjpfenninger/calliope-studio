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
 */
import { Plus, X } from "lucide-vue-next";

import InheritedFields from "./InheritedFields.vue";
import ScalarOrDataVar from "./ScalarOrDataVar.vue";
import { Switch } from "@/components/ui/switch";
import {
  DANGER_ICON_BUTTON,
  FIELD,
  FIELD_LABEL,
  GHOST_BUTTON,
  ICON_BUTTON,
  SECTION_HEADING,
} from "@/lib/formClasses";
import { ICON_STROKE_WIDTH } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { NodeEntry } from "@/lib/entries";
import {
  describeParams,
  paramSources,
  type DataTableParam,
} from "@/lib/dataTableParams";

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

function isFieldOverridden(key: string): boolean {
  if (key === "template") return false;
  if (key === "active") return props.entry.active === false;
  if (key === "latitude") return props.entry.latitude !== null;
  if (key === "longitude") return props.entry.longitude !== null;
  if (key === "techs") return props.entry.techs.length > 0;
  return props.entry.extraParams.some((param) => param.key === key);
}

function formatTemplateValue(value: any): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Template fields, as displayable strings. */
function templateFields(): Record<string, string> {
  const raw = (props.entry.template && props.templates[props.entry.template]) || {};
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, formatTemplateValue(value)]),
  );
}

function dataTableFields(): Record<string, string> {
  return describeParams(props.dataTableParams);
}

function dataTableSources(): Record<string, string> {
  return paramSources(props.dataTableParams);
}

/** A coordinate field writes a number, or null — never the DOM's string. */
function setCoordinate(key: "latitude" | "longitude", raw: string) {
  const trimmed = raw.trim();
  props.entry[key] = trimmed === "" ? null : Number(trimmed);
  onChange();
}

function addExtraParam() {
  props.entry.extraParams.push({ key: "", value: null });
  onChange();
}

function removeExtraParam(index: number) {
  props.entry.extraParams.splice(index, 1);
  onChange();
}

function addTech() {
  props.entry.techs.push({ techName: "", params: [] });
  onChange();
}

function removeTech(index: number) {
  props.entry.techs.splice(index, 1);
  onChange();
}

function addTechParam(index: number) {
  props.entry.techs[index].params.push({ key: "", value: null });
  onChange();
}

function removeTechParam(techIndex: number, paramIndex: number) {
  props.entry.techs[techIndex].params.splice(paramIndex, 1);
  onChange();
}
</script>

<template>
  <div class="flex flex-col gap-2 pb-2">
    <div class="flex flex-col gap-1">
      <label :class="FIELD_LABEL">name</label>
      <input
        v-model="entry.name"
        type="text"
        data-testid="node-name"
        :class="FIELD"
        @input="onChange"
      />
    </div>

    <div class="flex flex-col gap-1">
      <label :class="FIELD_LABEL">template</label>
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
    </div>

    <div class="flex items-center justify-between gap-2">
      <label :class="FIELD_LABEL">active</label>
      <Switch v-model="entry.active" @update:model-value="onChange" />
    </div>

    <div class="flex gap-2">
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <label :class="FIELD_LABEL">latitude</label>
        <input
          :value="entry.latitude ?? ''"
          type="number"
          step="any"
          min="-90"
          max="90"
          data-testid="node-latitude"
          :class="FIELD"
          @change="setCoordinate('latitude', ($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <label :class="FIELD_LABEL">longitude</label>
        <input
          :value="entry.longitude ?? ''"
          type="number"
          step="any"
          min="-180"
          max="180"
          data-testid="node-longitude"
          :class="FIELD"
          @change="setCoordinate('longitude', ($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>

    <div v-if="entry.extraParams.length" class="flex flex-col gap-1">
      <div
        v-for="(param, index) in entry.extraParams"
        :key="index"
        class="flex items-start gap-1"
      >
        <input
          v-model="param.key"
          type="text"
          placeholder="parameter"
          :class="cn(FIELD, 'w-36 shrink-0')"
          @input="onChange"
        />
        <ScalarOrDataVar
          :model-value="param.value"
          @update:model-value="
            param.value = $event;
            onChange();
          "
        />
        <button
          type="button"
          title="Remove this parameter"
          :class="DANGER_ICON_BUTTON"
          @click="removeExtraParam(index)"
        >
          <X class="size-3.5" :stroke-width="2" />
        </button>
      </div>
    </div>

    <button type="button" :class="cn(GHOST_BUTTON, 'self-start')" @click="addExtraParam">
      <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
      Add parameter
    </button>

    <!-- Per-node technology overrides: the same tech, tuned here. -->
    <div class="flex flex-col gap-1.5 rounded-sm border border-border p-2">
      <div class="flex items-center justify-between">
        <span :class="SECTION_HEADING">techs</span>
        <button
          type="button"
          title="Add a technology"
          :class="ICON_BUTTON"
          @click="addTech"
        >
          <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
        </button>
      </div>

      <div
        v-for="(techOvr, ti) in entry.techs"
        :key="ti"
        class="flex flex-col gap-1 border-t border-border-subtle pt-1.5 first:border-t-0 first:pt-0"
      >
        <div class="flex items-center gap-1">
          <input
            v-model="techOvr.techName"
            type="text"
            placeholder="tech name"
            :class="FIELD"
            @input="onChange"
          />
          <button
            type="button"
            title="Remove this technology"
            :class="DANGER_ICON_BUTTON"
            @click="removeTech(ti)"
          >
            <X class="size-3.5" :stroke-width="2" />
          </button>
        </div>

        <div
          v-for="(param, pi) in techOvr.params"
          :key="pi"
          class="flex items-start gap-1"
        >
          <input
            v-model="param.key"
            type="text"
            placeholder="parameter"
            :class="cn(FIELD, 'w-36 shrink-0')"
            @input="onChange"
          />
          <ScalarOrDataVar
            :model-value="param.value"
            @update:model-value="
              param.value = $event;
              onChange();
            "
          />
          <button
            type="button"
            title="Remove this override"
            :class="DANGER_ICON_BUTTON"
            @click="removeTechParam(ti, pi)"
          >
            <X class="size-3.5" :stroke-width="2" />
          </button>
        </div>

        <button
          type="button"
          :class="cn(GHOST_BUTTON, 'self-start')"
          @click="addTechParam(ti)"
        >
          <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
          Add override
        </button>
      </div>

      <p v-if="!entry.techs.length" class="text-2xs text-text-faint">
        No techs assigned.
      </p>
    </div>

    <InheritedFields
      v-if="entry.template"
      :label="`From: ${entry.template}`"
      :fields="templateFields()"
      :is-overridden="isFieldOverridden"
      empty-text="Template definition not available."
    />

    <InheritedFields
      v-if="Object.keys(dataTableParams).length"
      label="From data tables"
      :fields="dataTableFields()"
      :sources="dataTableSources()"
      :is-overridden="isFieldOverridden"
    />
  </div>
</template>
