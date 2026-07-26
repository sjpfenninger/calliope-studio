<script setup lang="ts">
import "maplibre-gl/dist/maplibre-gl.css";
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import maplibregl, { type StyleSpecification } from "maplibre-gl";

/**
 * The map, for both halves of the app.
 *
 * The editor renders a model's geography from its YAML; the results view
 * renders the same geography with values on it. Both receive the same GeoJSON,
 * so this component does not know or care whether the model has been solved.
 *
 * Selection is ordinary component state. v0.2.0 needed a server-side Bokeh
 * callback for it, which is exactly what could not survive a change of
 * frontend.
 */

export interface GeoPayload {
  nodes: GeoJSON.FeatureCollection;
  links: GeoJSON.FeatureCollection;
  bounds: [[number, number], [number, number]] | null;
  colors?: Record<string, string>;
}

const props = withDefaults(
  defineProps<{
    geo: GeoPayload | null;
    selected?: string[];
    /** Per-node values, sizing the markers when results are being shown. */
    values?: Record<string, number> | null;
    interactive?: boolean;
    height?: string;
  }>(),
  { selected: () => [], values: null, interactive: true, height: "100%" },
);

const emit = defineEmits<{ "update:selected": [string[]] }>();

const container = ref<HTMLDivElement | null>(null);
const map = shallowRef<maplibregl.Map | null>(null);
const ready = ref(false);

const MIN_RADIUS = 5;
const MAX_RADIUS = 22;

/**
 * OpenStreetMap raster tiles, declared inline.
 *
 * A vector basemap would look better but every hosted style needs an API key,
 * and an energy model viewer should not require signing up for a tile service
 * to see where its nodes are.
 */
const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

function nodeFeatures(): GeoJSON.FeatureCollection {
  const source = props.geo?.nodes ?? emptyCollection();
  const values = props.values ?? {};
  const magnitudes = Object.values(values).map(Math.abs);
  const largest = magnitudes.length ? Math.max(...magnitudes) : 0;

  return {
    type: "FeatureCollection",
    features: source.features.map((feature) => {
      const id = String(feature.id ?? "");
      const value = values[id];
      // Area-proportional, not radius-proportional: a value twice as large
      // should look twice as big, and radius alone exaggerates it.
      const scale =
        largest > 0 && value != null ? Math.sqrt(Math.abs(value) / largest) : 0;
      return {
        ...feature,
        properties: {
          ...feature.properties,
          selected: props.selected.includes(id),
          value: value ?? null,
          radius: largest > 0 ? MIN_RADIUS + scale * (MAX_RADIUS - MIN_RADIUS) : 7,
        },
      };
    }),
  };
}

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function setData() {
  const instance = map.value;
  if (!instance || !ready.value) return;
  (instance.getSource("nodes") as maplibregl.GeoJSONSource)?.setData(nodeFeatures());
  (instance.getSource("links") as maplibregl.GeoJSONSource)?.setData(
    props.geo?.links ?? emptyCollection(),
  );
}

function fit() {
  const instance = map.value;
  const bounds = props.geo?.bounds;
  if (!instance || !bounds) return;
  instance.fitBounds(bounds, { padding: 48, duration: 0, maxZoom: 9 });
}

function toggle(id: string) {
  const next = props.selected.includes(id)
    ? props.selected.filter((name) => name !== id)
    : [...props.selected, id];
  emit("update:selected", next);
}

function addLayers(instance: maplibregl.Map) {
  instance.addSource("links", { type: "geojson", data: emptyCollection() });
  instance.addSource("nodes", { type: "geojson", data: emptyCollection() });

  // Links first, so node markers sit on top of them.
  instance.addLayer({
    id: "links",
    type: "line",
    source: "links",
    layout: { "line-cap": "round" },
    paint: {
      "line-color": ["coalesce", ["get", "color"], "#94a3b8"],
      "line-width": 2.5,
      "line-opacity": 0.85,
    },
  });

  instance.addLayer({
    id: "nodes",
    type: "circle",
    source: "nodes",
    paint: {
      "circle-radius": ["get", "radius"],
      "circle-color": "#2a78d6",
      "circle-opacity": 0.85,
      "circle-stroke-width": ["case", ["get", "selected"], 3, 1.5],
      "circle-stroke-color": ["case", ["get", "selected"], "#111827", "#ffffff"],
    },
  });

  if (!props.interactive) return;

  const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 12,
  });

  instance.on("mousemove", "nodes", (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    instance.getCanvas().style.cursor = "pointer";
    const name = feature.properties?.node ?? feature.id;
    const value = feature.properties?.value;
    popup
      .setLngLat(event.lngLat)
      .setHTML(
        value == null
          ? `<strong>${name}</strong>`
          : `<strong>${name}</strong><br>${Number(value).toLocaleString()}`,
      )
      .addTo(instance);
  });

  instance.on("mouseleave", "nodes", () => {
    instance.getCanvas().style.cursor = "";
    popup.remove();
  });

  instance.on("click", "nodes", (event) => {
    const feature = event.features?.[0];
    if (feature) toggle(String(feature.properties?.node ?? feature.id));
  });
}

onMounted(() => {
  if (!container.value) return;
  const instance = new maplibregl.Map({
    container: container.value,
    style: STYLE,
    center: [0, 20],
    zoom: 1,
    attributionControl: { compact: true },
  });
  instance.addControl(new maplibregl.NavigationControl({ showCompass: false }));

  instance.on("load", () => {
    addLayers(instance);
    ready.value = true;
    setData();
    fit();
  });

  map.value = instance;
});

onBeforeUnmount(() => {
  map.value?.remove();
  map.value = null;
});

watch(() => props.geo, () => {
  setData();
  fit();
});
watch([() => props.selected, () => props.values], setData, { deep: true });
</script>

<template>
  <div class="map-root" :style="{ height }">
    <div
      v-if="geo && geo.nodes.features.length === 0"
      class="map-placeholder"
    >
      No nodes with coordinates to display.
      <span class="hint">Add latitude and longitude to your nodes.</span>
    </div>
    <div ref="container" class="map" />
  </div>
</template>

<style scoped>
.map-root {
  position: relative;
  width: 100%;
}

.map {
  width: 100%;
  height: 100%;
}

.map-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  z-index: 1;
  background: var(--p-surface-0, #fff);
  text-align: center;
  font-size: 0.875rem;
  color: var(--p-text-muted-color, #888);
}

.hint {
  font-size: 0.8rem;
  opacity: 0.8;
}
</style>
