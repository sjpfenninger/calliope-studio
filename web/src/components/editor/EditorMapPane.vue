<script setup lang="ts">
/**
 * The map half of a geographic editor: a strip, the map, and a detail pane.
 *
 * Both `nodes` and `links` use it, so the one behaviour that is easy to get
 * subtly different between them — what happens when the model's nodes are not all
 * placed — is written once. A model with any unplaced node greys the map out
 * entirely and says so: a map of *some* of the nodes is a misleading picture of
 * the model, and the fix is in the list, so that is where the button goes.
 */
import { List } from "@lucide/vue";
import PanelHeader from "@/components/app/PanelHeader.vue";

import ModelMap from "../map/ModelMap.vue";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { GHOST_BUTTON } from "@/lib/formClasses";

import { cn } from "@/lib/utils";
import type { GeoPayload } from "@/lib/mapGeo";
import { useUiStore } from "@/stores/ui";

/** How many unplaced nodes to name before saying "and N more". */
const NAMES_SHOWN = 6;

const props = withDefaults(
  defineProps<{
    geo: GeoPayload | null;
    selected?: string[];
    /** Nodes with no coordinates. Any at all greys the map out. */
    missing?: string[];
    /** Set when the geography could not be read at all. */
    error?: string | null;
    draggableNodes?: boolean;
    interactiveLinks?: boolean;
    pendingLinkFrom?: string | null;
  }>(),
  {
    selected: () => [],
    missing: () => [],
    error: null,
    draggableNodes: false,
    interactiveLinks: false,
    pendingLinkFrom: null,
  },
);

const emit = defineEmits<{
  "update:selected": [string[]];
  nodeClick: [string];
  nodeMoved: [{ node: string; latitude: number; longitude: number }];
  linkClick: [string];
  showList: [];
}>();

const ui = useUiStore();

function namesShown(): string {
  const names = props.missing.slice(0, NAMES_SHOWN).join(", ");
  const rest = props.missing.length - NAMES_SHOWN;
  return rest > 0 ? `${names} and ${rest} more` : names;
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="editor-map">
    <PanelHeader v-if="$slots.toolbar">
      <slot name="toolbar" />
    </PanelHeader>

    <ResizablePanelGroup
      direction="vertical"
      class="min-h-0 flex-1"
      @layout="ui.setMapSplit($event)"
    >
      <ResizablePanel :default-size="ui.mapSplit[0]" :min-size="25">
        <div class="relative h-full">
          <!-- An empty model gets a hint, not a cover: the map is the thing the
               user came to look at, and there is nothing wrong with it being
               empty yet. -->
          <p
        v-if="geo && !geo.nodes.features.length && !missing.length && !error"
            class="pointer-events-none absolute inset-x-0 top-2 z-[1] text-center text-sm text-text-muted"
            data-testid="map-empty-hint"
          >
            <slot name="empty">No nodes yet.</slot>
          </p>

          <ModelMap
            :geo="geo"
            :selected="selected"
            :draggable-nodes="draggableNodes"
            :interactive-links="interactiveLinks"
            :pending-link-from="pendingLinkFrom"
            :empty-message="false"
            single-select
            @update:selected="emit('update:selected', $event)"
            @node-click="emit('nodeClick', $event)"
            @node-moved="emit('nodeMoved', $event)"
            @link-click="emit('linkClick', $event)"
          >
            <template v-if="error || missing.length" #overlay>
              <template v-if="error">
                <span data-testid="map-error">{{ error }}</span>
              </template>
              <template v-else>
                <span data-testid="map-missing-coords">
                  Not all nodes have coordinates — first add coordinates to them.
                </span>
                <span class="text-sm text-text-faint">{{ namesShown() }}</span>
              </template>
              <button
                type="button"
                data-testid="map-show-list"
                :class="cn(GHOST_BUTTON, 'mt-1')"
                @click="emit('showList')"
              >
                <List class="size-3.5" />
                Show list
              </button>
            </template>
          </ModelMap>
        </div>
      </ResizablePanel>

      <ResizableHandle with-handle />

      <ResizablePanel :default-size="ui.mapSplit[1]" :min-size="15">
        <div class="h-full overflow-auto px-2 py-1.5" data-testid="map-detail">
          <slot name="detail" />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  </div>
</template>
