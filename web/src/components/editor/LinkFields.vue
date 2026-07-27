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
 */
import { Plus, X } from "lucide-vue-next";

import ScalarOrDataVar from "./ScalarOrDataVar.vue";
import { Switch } from "@/components/ui/switch";
import {
  DANGER_ICON_BUTTON,
  FIELD,
  FIELD_LABEL,
  GHOST_BUTTON,
} from "@/lib/formClasses";
import { ICON_STROKE_WIDTH } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { LinkEntry } from "@/lib/entries";

const props = defineProps<{
  entry: LinkEntry;
  /** Every template in the model, for the inherited note. */
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

function inheritedFrom(key: string): any {
  if (!props.entry.template) return undefined;
  return props.templates[props.entry.template]?.[key];
}

function addParam() {
  props.entry.params.push({ key: "", value: null });
  onChange();
}

function removeParam(index: number) {
  props.entry.params.splice(index, 1);
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
        data-testid="link-name"
        :class="FIELD"
        @input="onChange"
      />
    </div>

    <!-- The endpoints, which are what make this a link. Free text with
         suggestions rather than a closed list: a link may name a node defined in
         a file this editor has not loaded. -->
    <div class="flex gap-2">
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <label :class="FIELD_LABEL">link_from</label>
        <input
          v-model="entry.linkFrom"
          type="text"
          list="link-node-names"
          placeholder="node"
          data-testid="link-from"
          :class="FIELD"
          @change="onChange"
        />
      </div>
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <label :class="FIELD_LABEL">link_to</label>
        <input
          v-model="entry.linkTo"
          type="text"
          list="link-node-names"
          placeholder="node"
          data-testid="link-to"
          :class="FIELD"
          @change="onChange"
        />
      </div>
    </div>

    <div class="flex flex-col gap-1">
      <label :class="FIELD_LABEL">template</label>
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
    </div>

    <div class="flex items-center justify-between gap-2">
      <label :class="FIELD_LABEL">active</label>
      <Switch v-model="entry.active" @update:model-value="onChange" />
    </div>

    <p v-if="entry.template" class="text-2xs text-text-faint">
      Inherits from <code class="font-mono">{{ entry.template }}</code>
      <span v-if="inheritedFrom('base_tech')">
        (base_tech: {{ inheritedFrom("base_tech") }})
      </span>
    </p>

    <div v-if="entry.params.length" class="flex flex-col gap-1">
      <div
        v-for="(param, index) in entry.params"
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
          @click="removeParam(index)"
        >
          <X class="size-3.5" :stroke-width="2" />
        </button>
      </div>
    </div>

    <button type="button" :class="cn(GHOST_BUTTON, 'self-start')" @click="addParam">
      <Plus class="size-3.5" :stroke-width="ICON_STROKE_WIDTH" />
      Add parameter
    </button>
  </div>
</template>
