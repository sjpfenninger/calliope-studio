<script setup lang="ts">
/**
 * Back and forward, for the tab area.
 *
 * Following a link used to be a one-way trip: the provenance marker beside an
 * inherited field opens the template that supplies it, and a plain click
 * *previews*, so the click that opened the template also closed the tech behind
 * it. Back reopens it — see `lib/navHistory.ts` for why an entry is a tab id
 * rather than a reference to a tab.
 *
 * In `shell/` rather than `app/` because it is this shell's chrome and reads the
 * tabs store directly, where the composition layer's components take props.
 */
import { ArrowLeft, ArrowRight } from "@lucide/vue";

import TooltipButton from "@/components/app/TooltipButton.vue";
import { useTabsStore } from "@/stores/tabs";

const tabs = useTabsStore();
</script>

<template>
  <!-- 24px in a 32px strip, per the density contract. `side="bottom"`: the strip
       is the top of the tab area, so a tooltip above it would sit over the
       sidebar's header. -->
  <TooltipButton
    label="Back"
    :icon="ArrowLeft"
    side="bottom"
    :disabled="!tabs.canGoBack"
    testid="history-back"
    @click="tabs.back()"
  />
  <TooltipButton
    label="Forward"
    :icon="ArrowRight"
    side="bottom"
    :disabled="!tabs.canGoForward"
    testid="history-forward"
    @click="tabs.forward()"
  />
</template>
