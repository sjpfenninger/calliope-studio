<script setup lang="ts">
/**
 * Values this entry gets from somewhere else, and which of them it overrides.
 *
 * A technology's real definition is spread across three places — the entry
 * itself, the template it inherits from, and any data table that supplies the
 * parameter — and the editor is misleading if it shows only the first. The same
 * block appears in the techs, nodes and links editors, which is why it is a
 * component rather than three copies.
 *
 * An overridden value is struck through rather than hidden: knowing what the
 * template *would* have given you is the reason to look at all.
 */
defineProps<{
  label: string;
  /** Key → displayed value. */
  fields: Record<string, string>;
  /** Where each value came from, when that is not the label (a data table). */
  sources?: Record<string, string>;
  /** Which keys the entry sets itself. */
  isOverridden: (key: string) => boolean;
  emptyText?: string;
}>();
</script>

<template>
  <div class="flex flex-col gap-0.5 rounded-sm border border-border bg-surface-2 p-2">
    <span class="font-mono text-2xs font-semibold text-text-dim">{{ label }}</span>

    <div
      v-for="(value, key) in fields"
      :key="key"
      class="flex items-baseline gap-1.5 text-2xs"
    >
      <span class="min-w-32 shrink-0 font-mono text-text-faint">{{ key }}</span>
      <span
        class="min-w-0 flex-1 truncate font-mono"
        :class="isOverridden(String(key)) ? 'text-text-faint line-through' : ''"
      >
        {{ value }}
      </span>
      <span v-if="sources?.[key]" class="shrink-0 font-mono text-text-faint">
        {{ sources[key] }}
      </span>
      <span
        v-if="isOverridden(String(key))"
        class="shrink-0 rounded-xs bg-accent-soft px-1 text-accent-text"
      >
        overridden
      </span>
    </div>

    <p v-if="!Object.keys(fields).length" class="text-2xs text-text-faint">
      {{ emptyText ?? "Nothing to show." }}
    </p>
  </div>
</template>
