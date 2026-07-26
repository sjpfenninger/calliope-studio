<script setup lang="ts" generic="T extends string">
/**
 * Pick several options from a searchable list.
 *
 * shadcn-vue has no multi-select — its combobox is single-value — so this is the
 * usual Popover + Command recipe with checked items and a summarising trigger.
 * It is the filter sidebar's workhorse: a model can define dozens of
 * technologies and nodes, so the list has to be searchable and the trigger has
 * to stay one line however many are chosen.
 *
 * Selected values are shown as up to `maxVisible` badges and then a count, which
 * is what keeps a 28px control from growing into a paragraph.
 */
import { computed } from "vue";
import { Check, ChevronsUpDown, X } from "lucide-vue-next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    options: T[];
    placeholder?: string;
    searchPlaceholder?: string;
    emptyText?: string;
    /** How many chosen values to name before collapsing to a count. */
    maxVisible?: number;
    disabled?: boolean;
    class?: string;
  }>(),
  {
    placeholder: "Select…",
    searchPlaceholder: "Search…",
    emptyText: "Nothing matches.",
    maxVisible: 2,
  },
);

const selected = defineModel<T[]>({ default: () => [] });

const visible = computed(() => selected.value.slice(0, props.maxVisible));
const overflow = computed(() => Math.max(0, selected.value.length - props.maxVisible));

function toggle(option: T) {
  selected.value = selected.value.includes(option)
    ? selected.value.filter((value) => value !== option)
    : [...selected.value, option];
}

function clear(event: Event) {
  // The trigger would otherwise open the popover on its way past.
  event.stopPropagation();
  selected.value = [];
}
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <Button
        variant="outline"
        role="combobox"
        :disabled="disabled"
        :class="
          cn(
            'h-7 w-full justify-between gap-1 px-2 font-normal',
            !selected.length && 'text-muted-foreground',
            props.class,
          )
        "
      >
        <span class="flex min-w-0 items-center gap-1">
          <template v-if="selected.length">
            <Badge
              v-for="value in visible"
              :key="value"
              variant="secondary"
              class="h-4 max-w-24 truncate rounded-xs px-1 text-2xs font-normal"
            >
              {{ value }}
            </Badge>
            <span v-if="overflow" class="text-2xs text-text-faint">+{{ overflow }}</span>
          </template>
          <span v-else class="truncate">{{ placeholder }}</span>
        </span>

        <span class="flex shrink-0 items-center gap-0.5">
          <span
            v-if="selected.length"
            role="button"
            :aria-label="`Clear ${selected.length} selected`"
            class="grid size-4 place-items-center rounded-xs text-text-faint hover:bg-hover hover:text-foreground"
            @click="clear"
          >
            <X class="size-3" :stroke-width="2" />
          </span>
          <ChevronsUpDown class="size-3 text-text-faint" :stroke-width="2" />
        </span>
      </Button>
    </PopoverTrigger>

    <PopoverContent class="w-(--reka-popper-anchor-width) p-0" align="start">
      <Command>
        <CommandInput :placeholder="searchPlaceholder" class="h-7" />
        <CommandList>
          <CommandEmpty>{{ emptyText }}</CommandEmpty>
          <CommandGroup>
            <CommandItem
              v-for="option in options"
              :key="option"
              :value="option"
              class="gap-2"
              @select="toggle(option)"
            >
              <span
                :class="
                  cn(
                    'grid size-3.5 shrink-0 place-items-center rounded-xs border',
                    selected.includes(option)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border',
                  )
                "
              >
                <Check v-if="selected.includes(option)" class="size-2.5" :stroke-width="3" />
              </span>
              <span class="truncate">{{ option }}</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>
