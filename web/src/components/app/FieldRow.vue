<script setup lang="ts">
/**
 * One field of a structured editor: its key, its control, and where the value
 * would come from if the entry said nothing.
 *
 * Label-left rather than label-above. These forms are columns of near-identical
 * short values — a coordinate, an identifier, an enum — and stacking each over a
 * full-width box spent 44px of a fixed-height splitter pane on 24px of control,
 * with a `40.5` sitting in an input as wide as the window. The gutter is fixed
 * rather than `auto` so every value in the form starts at the same x, including
 * the parameter rows whose key is itself an input.
 *
 * **Provenance belongs on the field.** It used to be a separate table below the
 * form, which meant reading the same parameter twice in two typefaces and
 * getting no answer to the only question worth asking — is *this* field the one
 * that wins. So: an unset field shows what it would inherit as ghost text and
 * names the source; a set field keeps the inherited value visible but struck
 * through, because knowing what the template *would* have given you is the
 * reason to look at all, and offers to revert to it.
 *
 * `FIELD` is untouched and still `w-full` — the row owns the width, so there is
 * only ever one definition of a text field.
 */
import { computed } from "vue";
import { CornerDownRight, Undo2 } from "@lucide/vue";

import SourceLink from "./SourceLink.vue";
import TooltipButton from "./TooltipButton.vue";
import { FIELD_LABEL, FIELD_ROW, FIELD_ROW_WIDE, FIELD_WIDTH } from "@/lib/formClasses";
import type { FieldWidth } from "@/lib/formClasses";
import { cn } from "@/lib/utils";
import type { Inherited } from "@/lib/inherited";

const props = withDefaults(
  defineProps<{
    /** The key this field edits. */
    label: string;
    /** How much room the control gets. */
    width?: FieldWidth;
    /** `start` for a control taller than one row — a nested object, an indexed value. */
    align?: "center" | "start";
    /** `wide` where the key is a dotted path rather than a name. */
    gutter?: "default" | "wide";
    /** What a template or data table supplies for this key. */
    inherited?: Inherited | null;
    /** Whether the entry sets this key itself. */
    isSet?: boolean;
    /** Whether reverting is possible; a revert has to have somewhere to land. */
    revertable?: boolean;
  }>(),
  {
    width: "fill",
    align: "center",
    gutter: "default",
    inherited: null,
    isSet: false,
    revertable: true,
  },
);

defineEmits<{ revert: [] }>();

/**
 * Ghost text, and only when the field is empty: a placeholder under a value the
 * user has typed would be invisible anyway, and one that *looks* like a value is
 * how a display string ends up saved as a real one.
 */
const placeholder = computed(() =>
  props.isSet ? undefined : (props.inherited?.value ?? undefined),
);

const sourceNames = computed(() =>
  (props.inherited?.sources ?? []).map((source) => source.name).join(", "),
);

/** Every source, spelled out, for the marker's `title`. */
const sourceTitle = computed(() => {
  const inherited = props.inherited;
  if (!inherited) return undefined;
  const where = sourceNames.value;
  if (inherited.value === null) return `Set in more than one place: ${where}`;
  return `${props.label} = ${inherited.value} — from ${where}`;
});
</script>

<template>
  <div
    :class="
      cn(
        gutter === 'wide' ? FIELD_ROW_WIDE : FIELD_ROW,
        align === 'start' ? 'items-start' : 'items-center',
      )
    "
  >
    <!-- Slotted, because a parameter row's key is itself an input and has to sit
         in the same gutter as every fixed label, or the form loses its seam.

         design-check: allow native-title — the value is the label itself, so
         this is the browser revealing what a 9rem gutter clipped, not help. -->
    <slot name="label">
      <label
        :class="cn(FIELD_LABEL, 'truncate', align === 'start' ? 'pt-1' : '')"
        :title="label"
      >
        {{ label }}
      </label>
    </slot>

    <!-- Follows `align` too, so the remove button beside a three-row indexed
         value sits on its first row rather than floating against `index`. -->
    <div
      class="flex min-w-0 gap-1.5"
      :class="align === 'start' ? 'items-start' : 'items-center'"
    >
      <div :class="FIELD_WIDTH[width]">
        <slot :placeholder="placeholder" />
      </div>

      <!-- Sans, and at the badge step: a source is an annotation, not a key.

           A contested key names *both* sources rather than collapsing to "2
           sources" as it once did. That collapse existed so the marker would not
           read as an answer to a question only Calliope can answer — but each
           name is now a link to go and settle it, and the `title` still says the
           key is set in more than one place.

           design-check: allow native-title — `sourceTitle` is what the truncated
           spans below say, unclipped. -->
      <span
        v-if="inherited"
        class="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground"
        :title="sourceTitle"
      >
        <CornerDownRight class="size-3 shrink-0" />
        <span class="truncate">
          <template v-for="(source, index) in inherited.sources" :key="source.name">
            <template v-if="index">, </template>
            <SourceLink :source="source" />
          </template>
        </span>
        <span v-if="isSet && inherited.value" class="truncate text-text-faint line-through">
          {{ inherited.value }}
        </span>
      </span>

      <TooltipButton
        v-if="isSet && inherited && revertable"
        :label="`Revert to the value from ${sourceNames}`"
        :icon="Undo2"
        size="xs"
        @click="$emit('revert')"
      />

      <slot name="action" />
    </div>
  </div>
</template>
