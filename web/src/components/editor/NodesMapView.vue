<script setup lang="ts">
import "leaflet/dist/leaflet.css";
import { ref, computed, onMounted } from "vue";
import type L from "leaflet";
import { LMap, LTileLayer, LCircleMarker, LPolyline, LTooltip } from "@vue-leaflet/vue-leaflet";
import client from "../../api/client";
import { useComponentTreeStore } from "../../stores/componentTree";
import { useSectionDataStore } from "../../stores/sectionData";

const props = defineProps<{
  versionId: string;
  nodes: Array<{ name: string; latitude: number | null; longitude: number | null }>;
}>();

const componentTreeStore = useComponentTreeStore();
const sectionDataStore = useSectionDataStore();

interface LinkEntry {
  name: string;
  from: string;
  to: string;
}

const linkEntries = ref<LinkEntry[]>([]);

async function fetchLinksSection(file: string): Promise<Record<string, any>> {
  try {
    const res = await client.get<{ section: string; data: any }>(
      `/api/versions/${props.versionId}/yaml-section/${file}?section=links`
    );
    const d = res.data.data ?? {};
    sectionDataStore.set(props.versionId, file, "links", d);
    return d;
  } catch {
    return {};
  }
}

async function loadLinks() {
  const files = new Set<string>();
  const ct = componentTreeStore.tree?.links?.entries ?? [];
  for (const e of ct) {
    if (typeof e !== "string" && e.file) files.add(e.file);
  }
  const result: LinkEntry[] = [];
  for (const file of files) {
    const cached = sectionDataStore.get(props.versionId, file, "links");
    const data = cached ?? (await fetchLinksSection(file));
    for (const [name, raw] of Object.entries(data ?? {})) {
      const r = raw as Record<string, any> | null;
      if (r?.from && r?.to) result.push({ name, from: r.from, to: r.to });
    }
  }
  linkEntries.value = result;
}

const plottableNodes = computed(() =>
  props.nodes.filter((n) => n.latitude !== null && n.longitude !== null)
);

const nodeByName = computed(() =>
  Object.fromEntries(plottableNodes.value.map((n) => [n.name, n]))
);

const plottableLinks = computed(() =>
  linkEntries.value.flatMap((link) => {
    const a = nodeByName.value[link.from];
    const b = nodeByName.value[link.to];
    if (!a || !b) return [];
    return [
      {
        name: link.name,
        points: [
          [a.latitude as number, a.longitude as number] as [number, number],
          [b.latitude as number, b.longitude as number] as [number, number],
        ],
      },
    ];
  })
);

// Fit-bounds box for all plottable nodes
const mapBounds = computed<[[number, number], [number, number]] | null>(() => {
  const pts = plottableNodes.value;
  if (!pts.length) return null;
  const lats = pts.map((n) => n.latitude as number);
  const lngs = pts.map((n) => n.longitude as number);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  // Add a small padding when all nodes are at the same point
  const padLat = minLat === maxLat ? 1 : 0;
  const padLng = minLng === maxLng ? 1 : 0;
  return [
    [minLat - padLat, minLng - padLng],
    [maxLat + padLat, maxLng + padLng],
  ];
});

// Fallback center when no nodes have coordinates
const fallbackCenter: [number, number] = [20, 0];

function onMapReady(leafletMap: L.Map) {
  if (mapBounds.value) {
    leafletMap.fitBounds(mapBounds.value, { padding: [40, 40] });
  }
}

onMounted(() => loadLinks());
</script>

<template>
  <div class="map-root">
    <div v-if="plottableNodes.length === 0" class="map-placeholder">
      No nodes with coordinates to display.<br />
      <span class="map-hint">Add latitude and longitude to your nodes to see them on the map.</span>
    </div>

    <LMap
      v-else
      :center="fallbackCenter"
      :zoom="2"
      :use-global-leaflet="false"
      style="width: 100%; height: 100%"
      @ready="onMapReady"
    >
      <LTileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors"
        layer-type="base"
        name="OpenStreetMap"
      />

      <!-- Link lines — drawn first so markers sit on top -->
      <LPolyline
        v-for="link in plottableLinks"
        :key="link.name"
        :lat-lngs="link.points"
        color="#94a3b8"
        :weight="2"
        :opacity="0.85"
      >
        <LTooltip>{{ link.name }}</LTooltip>
      </LPolyline>

      <!-- Node markers -->
      <LCircleMarker
        v-for="node in plottableNodes"
        :key="node.name"
        :lat-lng="[node.latitude as number, node.longitude as number]"
        :radius="7"
        color="#6366f1"
        fill-color="#6366f1"
        :fill-opacity="0.85"
      >
        <LTooltip>{{ node.name }}</LTooltip>
      </LCircleMarker>
    </LMap>
  </div>
</template>

<style scoped>
.map-root {
  width: 100%;
  height: 100%;
  position: relative;
}

.map-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  color: var(--p-text-muted-color, #888);
  font-size: 0.875rem;
  gap: 0.5rem;
}

.map-hint {
  font-size: 0.8rem;
  color: var(--p-text-muted-color, #aaa);
}
</style>
