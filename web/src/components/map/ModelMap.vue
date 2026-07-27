<script setup lang="ts">
// maplibre-gl.css is imported from style.css, not here: this component is lazily
// loaded, so its stylesheet landed after the overrides that restyle the map's
// chrome and reverted them. See the note there.
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import maplibregl, { type StyleSpecification } from "maplibre-gl";

import { resolvedColor } from "../../lib/cssColor";
import { emptyCollection, type GeoPayload } from "../../lib/mapGeo";
import { useUiStore } from "../../stores/ui";

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
 *
 * On the editor side the map is also an *input*: a node is placed by dragging it
 * and a link is drawn by clicking its two endpoints. Every one of those
 * affordances is opt-in, so the results view behaves exactly as before. Note
 * what the drag deliberately does *not* do: it keeps no optimistic local
 * geometry. It emits the new position, the editor writes it into the entry it
 * owns, and the recomputed payload comes back down — which is also what makes
 * the links attached to a dragged node follow it, for free.
 */

const props = withDefaults(
  defineProps<{
    geo: GeoPayload | null;
    selected?: string[];
    /** Per-node values, sizing the markers when results are being shown. */
    values?: Record<string, number> | null;
    interactive?: boolean;
    height?: string;
    /** Enables dragging; a feature's own `editable` decides whether it moves. */
    draggableNodes?: boolean;
    /** Click replaces the selection instead of adding to it. */
    singleSelect?: boolean;
    /** Hover and click on the link lines, for editing them. */
    interactiveLinks?: boolean;
    /** Node a link is being drawn from: a dashed line follows the cursor. */
    pendingLinkFrom?: string | null;
    /**
     * Whether an empty map is covered with the "no nodes" message.
     *
     * The results view wants that: a solved model with no geography is a dead end.
     * The editors turn it off, because there an empty map is a map you are about
     * to put something on, not an error, and covering it hides the one thing the
     * user came to look at.
     */
    emptyMessage?: boolean;
  }>(),
  {
    selected: () => [],
    values: null,
    interactive: true,
    height: "100%",
    draggableNodes: false,
    singleSelect: false,
    interactiveLinks: false,
    pendingLinkFrom: null,
    emptyMessage: true,
  },
);

const emit = defineEmits<{
  "update:selected": [string[]];
  /**
   * A node was clicked, whatever that did to the selection. The links view needs
   * this: its two-click flow is about the clicks themselves, and inferring them
   * from how the selection array changed is guesswork.
   */
  nodeClick: [string];
  nodeMoved: [{ node: string; latitude: number; longitude: number }];
  linkClick: [string];
}>();

const ui = useUiStore();

const container = ref<HTMLDivElement | null>(null);
const map = shallowRef<maplibregl.Map | null>(null);
const ready = ref(false);

const MIN_RADIUS = 5;
const MAX_RADIUS = 22;

/** How far the pointer may travel during a press and still count as a click. */
const CLICK_SLOP = 3;

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

/**
 * How hard to drain the basemap, per theme.
 *
 * No dark tile provider is used, deliberately. The keyless options all have a
 * catch: CARTO's free CDN ties use to their platform and is rate-limited without
 * a contract, Stadia's keyless tiles only work from localhost (fine for the dev
 * server, broken for an installed tool), and Esri's terms contemplate an account.
 * None is something a locally-installed scientific tool should silently depend on
 * for every user.
 *
 * Desaturating the tiles already fetched is better anyway, and not only as a
 * dark-mode workaround: standard OSM is by far the most saturated thing on
 * screen, which breaks the achromatic-surfaces rule that the whole palette is
 * built on. Draining it is the fix in *both* themes.
 *
 * Dark dims rather than inverts — MapLibre has no raster-invert — giving a dark
 * grey basemap with legible but recessed geography.
 */
const BASEMAP_PAINT = {
  light: {
    "raster-saturation": -0.85,
    "raster-contrast": -0.15,
    "raster-brightness-min": 0.12,
    "raster-brightness-max": 0.97,
    "raster-opacity": 0.9,
  },
  dark: {
    "raster-saturation": -0.95,
    "raster-contrast": -0.1,
    "raster-brightness-min": 0,
    "raster-brightness-max": 0.34,
    "raster-opacity": 0.75,
  },
} as const;

/**
 * Data-layer colours, resolved from the tokens.
 *
 * MapLibre's paint parser cannot read `oklch` — its bundle contains no reference
 * to it — so these go through `lib/cssColor` like the other canvas renderers.
 *
 * Note what the node colour used to be: `#2a78d6`, which is `DEFAULT_PALETTE[0]`
 * from the server's technology palette. Every unstyled node was therefore drawn
 * in the *first technology's* colour, which looked deliberate and was not.
 */
function layerPaint() {
  return {
    // Per-feature colour still wins: `results/geo.py` stamps the technology
    // colour onto each link, and that is identity, not chrome.
    linkColor: [
      "coalesce",
      ["get", "color"],
      resolvedColor("--cg-text-faint", "#8f8f8f"),
    ] as maplibregl.ExpressionSpecification,
    nodeColor: resolvedColor("--cg-accent", "#026fff"),
    // Inverts with the theme, which is what keeps a selected node legible
    // against a dimmed basemap.
    nodeStrokeSelected: resolvedColor("--cg-text", "#1f1f1f"),
    nodeStroke: resolvedColor("--cg-surface", "#ffffff"),
    accent: resolvedColor("--cg-accent", "#026fff"),
  };
}

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

function setData() {
  const instance = map.value;
  if (!instance || !ready.value) return;
  (instance.getSource("nodes") as maplibregl.GeoJSONSource)?.setData(nodeFeatures());
  const links = props.geo?.links ?? emptyCollection();
  (instance.getSource("links") as maplibregl.GeoJSONSource)?.setData(links);
  (instance.getSource("links-hit") as maplibregl.GeoJSONSource)?.setData(links);
}

/**
 * The set of nodes on the map, as a value that only changes when a node appears
 * or disappears.
 *
 * The viewport is fitted on that, not on every payload: the editor rebuilds its
 * geometry on each drag frame and each keystroke in a coordinate field, and
 * re-fitting on those would yank the map out from under the pointer.
 */
function nodeSignature(): string {
  return (props.geo?.nodes.features ?? [])
    .map((feature) => String(feature.id))
    .sort()
    .join(" ");
}

let fittedSignature: string | null = null;

function fit(force = false) {
  const instance = map.value;
  const bounds = props.geo?.bounds;
  if (!instance || !bounds || dragging) return;
  const signature = nodeSignature();
  if (!force && signature === fittedSignature) return;
  fittedSignature = signature;
  instance.fitBounds(bounds, { padding: 48, duration: 0, maxZoom: 9 });
}

function select(id: string) {
  if (props.singleSelect) {
    emit("update:selected", props.selected.includes(id) && props.selected.length === 1 ? [] : [id]);
    return;
  }
  emit(
    "update:selected",
    props.selected.includes(id)
      ? props.selected.filter((name) => name !== id)
      : [...props.selected, id],
  );
}

// ── Dragging a node ────────────────────────────────────────────────────────
//
// A `circle` layer has no DOM element, so `maplibregl.Marker({draggable})` is not
// an option: this is MapLibre's own drag-a-point pattern, with `dragPan`
// suspended for the duration so the map does not pan instead.

let dragging: string | null = null;
let dragOrigin: { x: number; y: number } | null = null;
let dragTravel = 0;
let suppressClick = false;
let frame = 0;
let queued: maplibregl.LngLat | null = null;

function flushDrag() {
  frame = 0;
  if (!dragging || !queued) return;
  emit("nodeMoved", {
    node: dragging,
    latitude: queued.lat,
    longitude: queued.lng,
  });
  queued = null;
}

function endDrag() {
  const instance = map.value;
  if (!dragging || !instance) return;
  if (frame) {
    cancelAnimationFrame(frame);
    flushDrag();
  }
  instance.dragPan.enable();
  instance.getCanvas().style.cursor = "";
  // Swallow the click MapLibre is about to synthesise, or every drag also
  // changes the selection.
  suppressClick = dragTravel > CLICK_SLOP;
  dragging = null;
  dragOrigin = null;
}

// ── The line that follows the cursor while a link is being drawn ───────────

function pendingLine(cursor: maplibregl.LngLat | null): GeoJSON.FeatureCollection {
  const from = props.pendingLinkFrom;
  if (!from || !cursor) return emptyCollection();
  const feature = (props.geo?.nodes.features ?? []).find(
    (candidate) => String(candidate.id) === from,
  );
  if (!feature || feature.geometry?.type !== "Point") return emptyCollection();
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [feature.geometry.coordinates, [cursor.lng, cursor.lat]],
        },
        properties: {},
      },
    ],
  };
}

function setPending(cursor: maplibregl.LngLat | null) {
  const instance = map.value;
  if (!instance || !ready.value) return;
  (instance.getSource("pending") as maplibregl.GeoJSONSource)?.setData(
    pendingLine(cursor),
  );
}

/**
 * Repaints everything the theme touches.
 *
 * Never `setStyle`. Swapping the style destroys every custom source and layer,
 * so it would mean re-running `addLayers` and re-`setData`-ing on each theme
 * change, with a visible flash and a whole class of ordering bugs. Setting the
 * paint properties is nine cheap calls and touches nothing else.
 */
function applyTheme(instance: maplibregl.Map) {
  if (!instance.getLayer("osm")) return;

  const basemap = BASEMAP_PAINT[ui.mode];
  for (const [property, value] of Object.entries(basemap)) {
    instance.setPaintProperty("osm", property as keyof typeof basemap, value);
  }

  const paint = layerPaint();
  instance.setPaintProperty("links", "line-color", paint.linkColor);
  instance.setPaintProperty("pending", "line-color", paint.accent);
  instance.setPaintProperty("nodes", "circle-color", paint.nodeColor);
  instance.setPaintProperty("nodes", "circle-stroke-color", [
    "case",
    ["get", "selected"],
    paint.nodeStrokeSelected,
    paint.nodeStroke,
  ]);
}

function addLayers(instance: maplibregl.Map) {
  instance.addSource("links", { type: "geojson", data: emptyCollection() });
  instance.addSource("links-hit", { type: "geojson", data: emptyCollection() });
  instance.addSource("pending", { type: "geojson", data: emptyCollection() });
  instance.addSource("nodes", { type: "geojson", data: emptyCollection() });

  const paint = layerPaint();

  // Links first, so node markers sit on top of them.
  instance.addLayer({
    id: "links",
    type: "line",
    source: "links",
    layout: { "line-cap": "round" },
    paint: {
      "line-color": paint.linkColor,
      "line-width": 2.5,
      "line-opacity": 0.85,
    },
  });

  // A 2.5px line is not something anyone can hit with a mouse, and MapLibre has
  // no hit tolerance, so clicks go to a wide invisible twin.
  instance.addLayer({
    id: "links-hit",
    type: "line",
    source: "links-hit",
    paint: { "line-color": paint.linkColor, "line-width": 14, "line-opacity": 0 },
  });

  instance.addLayer({
    id: "pending",
    type: "line",
    source: "pending",
    layout: { "line-cap": "round" },
    paint: {
      "line-color": paint.accent,
      "line-width": 2,
      "line-dasharray": [2, 2],
    },
  });

  instance.addLayer({
    id: "nodes",
    type: "circle",
    source: "nodes",
    paint: {
      "circle-radius": ["get", "radius"],
      "circle-color": paint.nodeColor,
      "circle-opacity": 0.85,
      "circle-stroke-width": ["case", ["get", "selected"], 3, 1.5],
      "circle-stroke-color": [
        "case",
        ["get", "selected"],
        paint.nodeStrokeSelected,
        paint.nodeStroke,
      ],
    },
  });

  applyTheme(instance);

  if (!props.interactive) return;

  const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 12,
  });

  instance.on("mousemove", "nodes", (event) => {
    const feature = event.features?.[0];
    if (!feature || dragging) return;
    instance.getCanvas().style.cursor = props.draggableNodes ? "grab" : "pointer";
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
    if (dragging) return;
    instance.getCanvas().style.cursor = "";
    popup.remove();
  });

  instance.on("click", "nodes", (event) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const feature = event.features?.[0];
    if (!feature) return;
    const name = String(feature.properties?.node ?? feature.id);
    emit("nodeClick", name);
    select(name);
  });

  instance.on("mousedown", "nodes", (event) => {
    if (!props.draggableNodes) return;
    const feature = event.features?.[0];
    if (!feature || feature.properties?.editable === false) return;
    event.preventDefault();
    popup.remove();
    dragging = String(feature.properties?.node ?? feature.id);
    dragOrigin = { x: event.point.x, y: event.point.y };
    dragTravel = 0;
    suppressClick = false;
    instance.dragPan.disable();
    instance.getCanvas().style.cursor = "grabbing";
  });

  instance.on("mousemove", (event) => {
    if (props.pendingLinkFrom) setPending(event.lngLat);
    if (!dragging) return;
    if (dragOrigin) {
      dragTravel = Math.max(
        dragTravel,
        Math.hypot(event.point.x - dragOrigin.x, event.point.y - dragOrigin.y),
      );
    }
    queued = event.lngLat;
    if (!frame) frame = requestAnimationFrame(flushDrag);
  });

  instance.on("mouseup", endDrag);

  if (!props.interactiveLinks) return;

  instance.on("mousemove", "links-hit", (event) => {
    if (dragging || overNode(instance, event.point)) return;
    instance.getCanvas().style.cursor = "pointer";
    const feature = event.features?.[0];
    if (feature) {
      popup
        .setLngLat(event.lngLat)
        .setHTML(`<strong>${feature.properties?.tech ?? feature.id}</strong>`)
        .addTo(instance);
    }
  });

  instance.on("mouseleave", "links-hit", () => {
    if (dragging) return;
    instance.getCanvas().style.cursor = "";
    popup.remove();
  });

  instance.on("click", "links-hit", (event) => {
    // A layer-scoped handler fires even when another layer covers the point, so
    // a click on a node sitting on one of its own links would hit both.
    if (overNode(instance, event.point)) return;
    const feature = event.features?.[0];
    if (feature) emit("linkClick", String(feature.properties?.tech ?? feature.id));
  });
}

function overNode(instance: maplibregl.Map, point: maplibregl.PointLike): boolean {
  return instance.queryRenderedFeatures(point, { layers: ["nodes"] }).length > 0;
}

let observer: ResizeObserver | null = null;
let hadSize = false;

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

  // The map lives behind a `v-if` and inside a draggable splitter, so it can be
  // built at zero size and grow later. Nothing told it to re-measure before, and
  // a `fitBounds` computed against a 0×0 canvas is meaningless — hence the
  // re-fit the first time it has real dimensions.
  observer = new ResizeObserver(([entry]) => {
    instance.resize();
    const { width, height } = entry.contentRect;
    if (!hadSize && width > 0 && height > 0) {
      hadSize = true;
      fit(true);
    }
  });
  observer.observe(container.value);

  // A release outside the canvas still ends the drag.
  window.addEventListener("mouseup", endDrag);

  // The one testing seam in this component. The map draws to a canvas, so a node
  // has no DOM element and `data-testid` cannot reach it — and `npm run map-edit`
  // has to turn "region1" into a pixel to drag from. `map.project` is the only
  // thing that can do that, so the instance is reachable. Handy in the console
  // for the same reason.
  (window as unknown as { __cgMap?: maplibregl.Map }).__cgMap = instance;

  map.value = instance;
});

onBeforeUnmount(() => {
  window.removeEventListener("mouseup", endDrag);
  const global = window as unknown as { __cgMap?: maplibregl.Map };
  if (global.__cgMap === map.value) delete global.__cgMap;
  observer?.disconnect();
  observer = null;
  if (frame) cancelAnimationFrame(frame);
  map.value?.remove();
  map.value = null;
});

watch(
  () => props.geo,
  () => {
    setData();
    fit();
  },
);
watch([() => props.selected, () => props.values], setData, { deep: true });

watch(
  () => props.pendingLinkFrom,
  (from) => {
    if (!from) setPending(null);
  },
);

watch(
  () => ui.revision,
  () => {
    const instance = map.value;
    if (instance && ready.value) applyTheme(instance);
  },
);
</script>

<template>
  <div class="map-root" :style="{ height }">
    <!-- The overlay is a slot with the empty-model message as its fallback, so
         the editor can grey the map out over the top of a partly-placed model
         without this component knowing why. -->
    <div
      v-if="$slots.overlay || (emptyMessage && geo && geo.nodes.features.length === 0)"
      class="map-placeholder"
      :class="{ 'over-content': !!$slots.overlay }"
      data-testid="map-overlay"
    >
      <slot name="overlay">
        No nodes with coordinates to display.
        <span class="hint">Add latitude and longitude to your nodes.</span>
      </slot>
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
  background: var(--cg-surface);
  text-align: center;
  font-size: 12px;
  color: var(--cg-text-muted);
}

/* Greying out a map that does have something on it: the geography stays
   readable underneath, drained and blurred, and the overlay still swallows every
   pointer event so nothing can be edited through it. `color-mix` is fine here —
   this is DOM-only CSS, and no canvas ever has to parse it. */
.map-placeholder.over-content {
  background: color-mix(in oklch, var(--cg-surface) 72%, transparent);
  backdrop-filter: grayscale(1) blur(1.5px);
  padding: 1rem;
}

.hint {
  font-size: 0.8rem;
  opacity: 0.8;
}
</style>
