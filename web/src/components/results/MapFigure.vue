<script setup lang="ts">
/**
 * The map, as one figure of the results view.
 *
 * Its three frames are fetched by the pane above and passed in, not fetched
 * here: that is what makes switching layout, sub-view or tab cost no request at
 * all. Everything else it needs is in the per-handle selection store.
 */
import { computed, inject, ref, watch } from "vue";

import { Download } from "@lucide/vue";

import FigurePanel from "./FigurePanel.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import MapLegend from "@/components/map/MapLegend.vue";
import ModelMap from "@/components/map/ModelMap.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ResultFrame } from "@/api/results";
import { ordinalRamp } from "@/charts/theme";
import type { CsvSource } from "@/lib/frameCsv";
import { exportFrames, hasData } from "@/lib/frameExport";
import { FIELD_WIDTH } from "@/lib/formClasses";
import { nodeSlices, nodeTotals, valueExtent } from "@/lib/mapValues";
import { unitSuffix, type DisplayUnit } from "@/lib/units";
import { useRoundingStore } from "@/stores/rounding";
import { RUN_SELECTION, type MapChannel } from "@/stores/runSelection";
import { useUiStore } from "@/stores/ui";

const props = defineProps<{
  sizeFrame: ResultFrame | null;
  colorFrame: ResultFrame | null;
  pieFrame: ResultFrame | null;
  /**
   * What each channel's values are already scaled to.
   *
   * One per channel, not one for the map: three channels are three variables,
   * so the sizes can be in GWh while the colours are in MW.
   */
  sizeUnit: DisplayUnit | null;
  colorUnit: DisplayUnit | null;
  pieUnit: DisplayUnit | null;
  /** Any of the three channels still in flight. */
  loading?: boolean;
  /**
   * The first channel that failed, if one did.
   *
   * Without it a 500 on a map frame left the previous map on screen with
   * nothing to say the numbers were stale — the one figure that swallowed its
   * errors while the two charts beside it showed theirs.
   */
  error?: string | null;
}>();

/** A channel's variable name with its unit, for the legend and the map's hover. */
function channelLabel(name: string | null, unit: DisplayUnit | null): string | null {
  return name ? name + unitSuffix(unit) : null;
}

const store = inject(RUN_SELECTION)!;
// Per model rather than per handle — see `TimeseriesFigure`.
const rounding = useRoundingStore();
const ui = useUiStore();

// The reduction from a nodes-indexed frame to what the map draws lives in
// `lib/mapValues`, tested: there are three channels wanting it, and a marker
// sized from the wrong series is still a perfectly plausible-looking marker.
const mapSizes = computed(() => nodeTotals(props.sizeFrame));
const mapColors = computed(() => nodeTotals(props.colorFrame));
const mapPies = computed(() =>
  store.mapVariables.pie ? nodeSlices(props.pieFrame) : null,
);

/**
 * What the map's channels may be set to.
 *
 * Only variables carrying node data: everything else has nothing to put on a
 * node.
 */
const mapVariables = computed(() => store.catalog?.variables.static_nodes ?? []);

/**
 * The sentinel a `Select` uses for "no variable" — it cannot bind to null.
 *
 * Underscored rather than something prettier because it shares a value space
 * with variable names, and no Calliope variable is called this.
 */
const NONE = "__none__";

function channelValue(channel: MapChannel): string {
  return store.mapVariables[channel] ?? NONE;
}

function setChannel(channel: MapChannel, value: string) {
  store.mapVariables[channel] = value === NONE ? null : value;
}

// ── The legend ─────────────────────────────────────────────────────────────

const ramp = ref<string[]>([]);

/**
 * The ramp, re-read on every theme change.
 *
 * The swatches are DOM and could have used `var(--cg-chart-N)` directly, but the
 * map resolves the same tokens through `lib/cssColor` for its canvas — and a
 * legend whose colours are arrived at by a different route is a legend that can
 * disagree with the thing it explains.
 */
watch(
  () => ui.revision,
  () => {
    ramp.value = ordinalRamp();
  },
  { immediate: true },
);

const pieTechs = computed(() => {
  const pies = mapPies.value;
  if (!pies) return [];
  const seen = new Map<string, { key: string; label: string; color: string }>();
  for (const slices of Object.values(pies)) {
    for (const slice of slices) {
      if (seen.has(slice.key)) continue;
      seen.set(slice.key, {
        key: slice.key,
        // Links go by their endpoints, exactly as they do in the chart legends.
        label: store.techLabels[slice.key] ?? slice.key,
        color: slice.color ?? ramp.value[0] ?? "",
      });
    }
  }
  return [...seen.values()];
});

// ── Export ─────────────────────────────────────────────────────────────────

/**
 * What the map is showing, as one table.
 *
 * The map is the one figure with no single frame behind it: up to three channels
 * are drawn at once and each is its own query. They are all indexed by node, so
 * they join, and each column says which channel it came from — a file of three
 * unlabelled `value` columns would be worse than useless.
 */
const mapSources = computed<CsvSource[]>(() =>
  (
    [
      { channel: "size" as MapChannel, frame: props.sizeFrame, unit: props.sizeUnit },
      { channel: "color" as MapChannel, frame: props.colorFrame, unit: props.colorUnit },
      { channel: "pie" as MapChannel, frame: props.pieFrame, unit: props.pieUnit },
    ]
  )
    .map(({ channel, frame, unit }) => ({
      label: store.mapVariables[channel] ?? undefined,
      frame,
      unit,
    }))
    .filter((source) => source.label && hasData(source.frame)),
);

/** The name to file the map's export under, when several variables are on it. */
const mapVariableName = computed(
  () => mapSources.value.map((source) => source.label).join("-") || "map",
);
</script>

<template>
  <FigurePanel
    figure="map"
    title="Map"
    label="the map"
    testid="collapse-map"
    :busy="props.loading"
  >
    <template #controls>
      <!-- One picker per encoding channel. All three set to None is a real
           answer, not an empty state: the nodes stay on the map at a uniform
           size, which says where the model is and claims nothing about how much
           is at each node. -->
      <Select
        v-for="channel in (['size', 'color', 'pie'] as MapChannel[])"
        :key="channel"
        :model-value="channelValue(channel)"
        :disabled="channel === 'color' && Boolean(store.mapVariables.pie)"
        @update:model-value="(value) => setChannel(channel, String(value ?? NONE))"
      >
        <SelectTrigger
          size="sm"
          :class="FIELD_WIDTH.short"
          :data-testid="`map-${channel}-variable`"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="NONE">
            {{ { size: "No size", color: "No colour", pie: "No pie" }[channel] }}
          </SelectItem>
          <SelectItem v-for="name in mapVariables" :key="name" :value="name">
            {{ name }}
          </SelectItem>
        </SelectContent>
      </Select>

      <!-- Inline, with no spacer before it. A `flex-1` right-aligns it, and in a
           wrapping header that means a second row of its own — which side by
           side, at half the width, is every time. -->
      <TooltipButton
        label="Export the map's data as CSV"
        :icon="Download"
        testid="export-map"
        :disabled="!mapSources.length"
        @click="
          exportFrames(
            mapSources,
            mapVariableName,
            store.catalog?.name,
            store.techLabels,
            rounding.exportPrecision,
          )
        "
      />
    </template>

    <!-- No `height`: the default is already 100%, and the panel is what decides
         it. MapLibre tracks its container, so the drag drives the map with no
         extra wiring — and so does flipping the whole layout on its side. -->
    <ModelMap
      v-model:selected="store.mapNodes"
      :highlighted="store.hoveredNode"
      :geo="store.geo"
      :values="mapSizes"
      :color-values="mapColors"
      :pies="mapPies"
      :value-label="channelLabel(store.mapVariables.size, props.sizeUnit) ?? ''"
      :precision="rounding.precision"
      class="h-full"
    />
    <!-- The unit rides on the channel's name rather than being a prop of its own:
         a legend entry already reads `Size · flow_cap`, and `Size · flow_cap (MW)`
         is the same sentence finished. -->
    <MapLegend
      :size-label="channelLabel(store.mapVariables.size, props.sizeUnit)"
      :size-extent="valueExtent(mapSizes)"
      :color-label="
        store.mapVariables.pie
          ? null
          : channelLabel(store.mapVariables.color, props.colorUnit)
      "
      :color-extent="valueExtent(mapColors)"
      :ramp="ramp"
      :pie-label="channelLabel(store.mapVariables.pie, props.pieUnit)"
      :pie-techs="pieTechs"
      :selected="store.mapNodes.length > 0"
      :precision="rounding.precision"
    />
    <!-- Over the map *and* its legend, the way `ResultChart` covers its canvas:
         a legend explaining a map that is not the current answer is worse than
         no legend. -->
    <StateMessage
      v-if="props.error"
      variant="fill"
      tone="danger"
      class="absolute inset-0 z-raised bg-surface"
    >{{ props.error }}</StateMessage>
  </FigurePanel>
</template>
