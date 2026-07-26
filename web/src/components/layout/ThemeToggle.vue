<script setup lang="ts">
/**
 * Cycles light → dark → system.
 *
 * A toolbar button rather than something buried in a settings menu, because
 * "click through in both themes" is in this project's own test checklist and
 * needs to be one click. The current preference is the icon, so the three-state
 * cycle is legible without a label.
 *
 * Written with Tailwind utilities and lucide icons — the first component in the
 * app to use either.
 */
import { computed } from "vue";
import { Moon, MonitorCog, Sun } from "lucide-vue-next";

import { useUiStore } from "../../stores/ui";

const ui = useUiStore();

const icon = computed(() =>
  ui.preference === "light" ? Sun : ui.preference === "dark" ? Moon : MonitorCog,
);

const label = computed(
  () =>
    ({
      light: "Light theme",
      dark: "Dark theme",
      system: "Theme follows the system",
    })[ui.preference],
);
</script>

<template>
  <button
    type="button"
    data-testid="theme-toggle"
    :title="label"
    :aria-label="label"
    class="grid size-7 shrink-0 place-items-center rounded-sm text-text-dim transition-colors hover:bg-hover hover:text-foreground"
    @click="ui.cycleTheme()"
  >
    <component :is="icon" class="size-4" :stroke-width="1.75" />
  </button>
</template>
