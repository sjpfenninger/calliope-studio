<script setup lang="ts">
// maplibre-gl.css is imported from style.css, not here: this component is lazily
// loaded, so its stylesheet landed after the overrides that restyle the map's
// chrome and reverted them. See the note there.
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
// Namespace rather than default: maplibre-gl 6 is ESM-only and publishes no
// default export. Every `maplibregl.Thing` below — type and constructor alike —
// resolves through this unchanged.
import * as maplibregl from "maplibre-gl";
// v6 finds its worker through `import.meta.url`, which a bundler's module graph
// does not resolve to anything fetchable — so the worker never starts, and
// because nothing throws, the map comes up with a correctly sized canvas whose
// style stays permanently unloaded: no layers, no markers, no error. Naming it
// through Vite is what makes it real. `?worker&url` rather than `?url` because
// the worker imports maplibre's shared chunk, which a bare asset copy leaves
// behind.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

import {
  basemapPaint,
  basemapStyle,
  RASTER_LAYER,
  RASTER_PAINT,
  VECTOR_LAYERS,
  VECTOR_SOURCE,
} from "../../lib/basemap";
import { resolvedColor } from "../../lib/cssColor";
import { ordinalRamp } from "../../charts/theme";
import { MapPinOff } from "@lucide/vue";
import StateMessage from "../app/StateMessage.vue";
import { emptyCollection, type GeoPayload } from "../../lib/mapGeo";
import { largestMagnitude, valueExtent, type PieSlice } from "../../lib/mapValues";
import { donutSvg, escapeText } from "../../lib/pieMarker";
import { formatValue } from "../../lib/precision";
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
    /**
     * Per-node values colouring the markers, on the sequential chart ramp.
     *
     * A separate channel from `values` on purpose: sizing by capacity while
     * colouring by cost is the comparison the map is for, and tying the two to
     * one variable would have made it a picture of the same number twice.
     */
    colorValues?: Record<string, number> | null;
    /**
     * Per-node composition, drawn as a donut instead of a circle.
     *
     * Takes over the colour channel when set — a wedge is coloured by its
     * technology, which is identity and cannot also carry a magnitude — while
     * `values` still decides how big the donut is.
     */
    pies?: Record<string, PieSlice[]> | null;
    /** What `values` is, for the hover popup. */
    valueLabel?: string;
    /**
     * Significant figures for the hover popup, or null for full precision.
     *
     * Null on the editor side, which shows no values at all. See
     * `lib/precision.ts` for why the popup, the tooltip and the table share one
     * rule now.
     */
    precision?: number | null;
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
    colorValues: null,
    pies: null,
    valueLabel: "",
    precision: null,
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

// Once for the module, not once per map: the setting is global to maplibre, and
// this component is the only thing that constructs one.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

const ui = useUiStore();

const container = ref<HTMLDivElement | null>(null);
const map = shallowRef<maplibregl.Map | null>(null);
const ready = ref(false);

const MIN_RADIUS = 5;
const MAX_RADIUS = 22;

/** Every node's radius when nothing is sizing them. */
const UNIFORM_RADIUS = 7;

/** How thick a donut's ring is, as a fraction of its radius. */
const DONUT_THICKNESS = 0.55;

/** How many pie slices a hover names before it says "and more". */
const PIE_TOOLTIP_ROWS = 5;

/** How far the pointer may travel during a press and still count as a click. */
const CLICK_SLOP = 3;

/**
 * Whether the vector tiles failed and the raster fallback is showing.
 *
 * `lib/basemap` explains the choice of provider. Keyless does not mean always
 * reachable — a machine offline, behind a proxy, or looking at a model while the
 * tile host is down still has a model to place, so a basemap that cannot load
 * falls back to plain OpenStreetMap raster tiles rather than to a blank canvas.
 * The fallback layer is already in the style with `visibility: none`, so this is
 * a visibility flip and not a `setStyle` — see `applyTheme` for why that matters.
 */
const fellBack = ref(false);

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
  const accent = resolvedColor("--cg-accent", "#026fff");
  return {
    // Per-feature colour still wins: `results/geo.py` stamps the technology
    // colour onto each link, and that is identity, not chrome.
    linkColor: [
      "coalesce",
      ["get", "color"],
      resolvedColor("--cg-text-faint", "#8f8f8f"),
    ] as maplibregl.ExpressionSpecification,
    // One resolution under both the names it is used by: the default node
    // fill, and the selection ring and pending-link line.
    nodeColor: accent,
    // Inverts with the theme, which is what keeps a selected node legible
    // against a dimmed basemap.
    nodeStrokeSelected: resolvedColor("--cg-text", "#1f1f1f"),
    nodeStroke: resolvedColor("--cg-surface", "#ffffff"),
    accent,
  };
}

/** The ordinal chart ramp, resolved, darkest first. */
const rampStops = ordinalRamp;

/**
 * `circle-color` for the colour channel.
 *
 * Interpolates the five `--cg-chart-*` steps over the normalised value each
 * feature carries. That ramp is one hue family with stepped lightness and is
 * deliberately *not* the technology palette, which is what makes it readable as a
 * magnitude here and impossible to confuse with tech identity — a node coloured
 * from the tech palette would claim to *be* a technology.
 *
 * A node the query returned nothing for keeps the flat accent rather than
 * landing at the bottom of the ramp, because "no value" and "the smallest value"
 * are different facts.
 */
function nodeColorExpression(fallback: string): maplibregl.ExpressionSpecification {
  const stops = rampStops();
  return [
    "case",
    ["==", ["get", "shade"], -1],
    fallback,
    [
      "interpolate",
      ["linear"],
      ["get", "shade"],
      ...stops.flatMap((color, step) => [step / (stops.length - 1), color]),
    ],
  ] as maplibregl.ExpressionSpecification;
}

/** Whether the colour channel is carrying anything. */
function hasColorChannel(): boolean {
  return !props.pies && Object.keys(props.colorValues ?? {}).length > 0;
}

function nodeFeatures(): GeoJSON.FeatureCollection {
  const source = props.geo?.nodes ?? emptyCollection();
  const values = props.values ?? {};
  const largest = largestMagnitude(values);
  const colorValues = props.colorValues ?? {};
  const extent = hasColorChannel() ? valueExtent(colorValues) : null;

  return {
    type: "FeatureCollection",
    features: source.features.map((feature) => {
      const id = String(feature.id ?? "");
      const value = values[id];
      return {
        ...feature,
        properties: {
          ...feature.properties,
          selected: props.selected.includes(id),
          value: value ?? null,
          colorValue: colorValues[id] ?? null,
          // -1 rather than null: MapLibre's `interpolate` cannot be handed a
          // missing input, and a sentinel outside 0–1 is what the `case` above
          // tests for. A single-valued extent normalises to the ramp's top, not
          // to a division by zero.
          shade: shadeOf(colorValues[id], extent),
          radius: nodeRadius(largest, value),
        },
      };
    }),
  };
}

/** Where a value sits on the ramp, 0–1, or -1 when it has none. */
function shadeOf(
  value: number | undefined,
  extent: [number, number] | null,
): number {
  if (extent === null || value == null || !Number.isFinite(value)) return -1;
  const [min, max] = extent;
  return max === min ? 1 : (value - min) / (max - min);
}

/**
 * Marker radius for one node.
 *
 * Area-proportional, not radius-proportional: a value twice as large should look
 * twice as big, and scaling the radius exaggerates it. With no size channel every
 * node is the same small dot, which is the "nothing at all" case — the map still
 * says where the model is, and claims nothing about how much is there.
 */
function nodeRadius(largest: number, value: number | undefined): number {
  if (largest <= 0 || value == null) return UNIFORM_RADIUS;
  const scale = Math.sqrt(Math.abs(value) / largest);
  return MIN_RADIUS + scale * (MAX_RADIUS - MIN_RADIUS);
}

// ── Pies ───────────────────────────────────────────────────────────────────
//
// MapLibre has no pie mark and no paint property that could make one, so a node
// showing composition is an SVG donut in a `maplibregl.Marker` — DOM the map keeps
// positioned, which also means the click and hover it needs are ordinary listeners.
//
// The markers are kept in a map keyed by node and updated in place. Recreating
// them on every payload would tear a marker out from under the pointer mid-hover,
// and on the editor side `pies` is never set, so none of this runs there at all.

const donuts = new Map<string, maplibregl.Marker>();

/** Removes every donut, for when the pie channel is switched off. */
function clearDonuts() {
  for (const marker of donuts.values()) marker.remove();
  donuts.clear();
}

function donutElement(node: string, slices: PieSlice[], radius: number): string {
  const paint = layerPaint();
  return donutSvg(slices, {
    radius,
    thickness: DONUT_THICKNESS,
    stroke: props.selected.includes(node) ? paint.nodeStrokeSelected : paint.nodeStroke,
    strokeWidth: props.selected.includes(node) ? 2 : 1,
    fallbackColor: paint.nodeColor,
    label: node,
  });
}

function syncDonuts() {
  const instance = map.value;
  if (!instance || !ready.value) return;

  const pies = props.pies;
  if (!pies) {
    clearDonuts();
    return;
  }

  const largest = largestMagnitude(props.values ?? {});
  const seen = new Set<string>();

  for (const feature of props.geo?.nodes.features ?? []) {
    const node = String(feature.id ?? "");
    const slices = pies[node];
    if (!slices?.length || feature.geometry.type !== "Point") continue;
    seen.add(node);

    const radius = nodeRadius(largest, (props.values ?? {})[node]);
    const html = donutElement(node, slices, radius);

    let marker = donuts.get(node);
    if (!marker) {
      const element = document.createElement("div");
      element.style.cursor = "pointer";
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        emit("nodeClick", node);
        select(node);
      });
      marker = new maplibregl.Marker({ element }).setLngLat(
        feature.geometry.coordinates as [number, number],
      );
      marker.addTo(instance);
      donuts.set(node, marker);
    } else {
      marker.setLngLat(feature.geometry.coordinates as [number, number]);
    }
    // Only the inner SVG is replaced: the element itself carries the click
    // listener, and swapping it would drop the listener silently.
    marker.getElement().innerHTML = html;
  }

  for (const [node, marker] of donuts) {
    if (seen.has(node)) continue;
    marker.remove();
    donuts.delete(node);
  }
}

/**
 * What hovering a node says.
 *
 * Names the variable rather than showing a bare number: with three channels on
 * offer, a figure with no label is a figure the reader has to go and look up in
 * the header. Values are read from the props rather than from the feature so a
 * donut, which has no feature under the pointer, says the same thing.
 */
function popupHtml(node: string): string {
  const rows: string[] = [`<strong>${escapeText(node)}</strong>`];

  const value = (props.values ?? {})[node];
  if (value != null) {
    const label = props.valueLabel ? `${escapeText(props.valueLabel)}: ` : "";
    // `formatValue` rather than `toLocaleString`: this and the table cell are the
    // same number, and they used to disagree about both grouping and precision,
    // so hovering a node and then finding it in the table read as two answers.
    rows.push(`${label}${formatValue(value, props.precision)}`);
  }

  const slices = props.pies?.[node];
  if (slices?.length) {
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    rows.push(
      ...slices
        .slice(0, PIE_TOOLTIP_ROWS)
        .map(
          (slice) =>
            `${escapeText(slice.key)}: ${Math.round((slice.value / total) * 100)}%`,
        ),
    );
    if (slices.length > PIE_TOOLTIP_ROWS) {
      rows.push(`+${slices.length - PIE_TOOLTIP_ROWS} more`);
    }
  }

  return rows.join("<br>");
}

function setData() {
  const instance = map.value;
  if (!instance || !ready.value) return;
  (instance.getSource("nodes") as maplibregl.GeoJSONSource)?.setData(nodeFeatures());
  const links = props.geo?.links ?? emptyCollection();
  (instance.getSource("links") as maplibregl.GeoJSONSource)?.setData(links);
  (instance.getSource("links-hit") as maplibregl.GeoJSONSource)?.setData(links);

  // The circle layer and the donuts are two ways of drawing the same node, so
  // exactly one of them is up at a time. Hiding the layer rather than emptying
  // its source keeps `queryRenderedFeatures` honest: `overNode` uses it to stop a
  // click on a node also reaching the link underneath.
  if (instance.getLayer("nodes")) {
    instance.setLayoutProperty(
      "nodes",
      "visibility",
      props.pies ? "none" : "visible",
    );
  }
  syncDonuts();
  applyNodePaint(instance);
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
    .join("\u001f");
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
 * The node layer's colours.
 *
 * Split out of `applyTheme` because it no longer depends on the theme alone:
 * whether `circle-color` is the flat accent or the ramp is a function of the
 * data, so switching the colour channel on has to repaint without waiting for a
 * theme change.
 */
function applyNodePaint(instance: maplibregl.Map) {
  if (!instance.getLayer("nodes")) return;
  const paint = layerPaint();
  instance.setPaintProperty(
    "nodes",
    "circle-color",
    hasColorChannel() ? nodeColorExpression(paint.nodeColor) : paint.nodeColor,
  );
  instance.setPaintProperty("nodes", "circle-stroke-color", [
    "case",
    ["get", "selected"],
    paint.nodeStrokeSelected,
    paint.nodeStroke,
  ]);
}

/**
 * Repaints everything the theme touches.
 *
 * Never `setStyle`. Swapping the style destroys every custom source and layer,
 * so it would mean re-running `addLayers` and re-`setData`-ing on each theme
 * change, with a visible flash and a whole class of ordering bugs. Setting the
 * paint properties is a handful of cheap calls and touches nothing else.
 */
function applyTheme(instance: maplibregl.Map) {
  if (!instance.getLayer("nodes")) return;

  for (const [layer, property, value] of basemapPaint()) {
    if (instance.getLayer(layer)) instance.setPaintProperty(layer, property, value);
  }

  const raster = RASTER_PAINT[ui.mode];
  for (const [property, value] of Object.entries(raster)) {
    instance.setPaintProperty(RASTER_LAYER, property as keyof typeof raster, value);
  }

  const paint = layerPaint();
  instance.setPaintProperty("links", "line-color", paint.linkColor);
  instance.setPaintProperty("pending", "line-color", paint.accent);
  applyNodePaint(instance);
  // The donuts are SVG, not paint properties, so their strokes only follow the
  // theme if they are redrawn.
  syncDonuts();
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
    const name = String(feature.properties?.node ?? feature.id);
    popup.setLngLat(event.lngLat).setHTML(popupHtml(name)).addTo(instance);
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
    style: basemapStyle(),
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

  // MapLibre reports a failed tile or TileJSON request here and nowhere else; it
  // does not throw, and without this a map whose tiles never arrive is simply
  // empty. One failure is enough to switch: a basemap that is half there is a
  // worse picture of a model's geography than a plain one.
  instance.on("error", (event) => {
    const sourceId = (event as { sourceId?: string }).sourceId;
    if (sourceId !== VECTOR_SOURCE || fellBack.value) return;
    fellBack.value = true;
    for (const layer of VECTOR_LAYERS) {
      if (instance.getLayer(layer)) {
        instance.setLayoutProperty(layer, "visibility", "none");
      }
    }
    instance.setLayoutProperty(RASTER_LAYER, "visibility", "visible");
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
  clearDonuts();
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
watch(
  [
    () => props.selected,
    () => props.values,
    () => props.colorValues,
    () => props.pies,
  ],
  setData,
  { deep: true },
);

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
  <div class="relative w-full" :style="{ height }">
    <!-- The overlay is a slot with the empty-model message as its fallback, so
         the editor can grey the map out over the top of a partly-placed model
         without this component knowing why.

         It deliberately does NOT set `pointer-events: none`: while the map is
         greyed there must be no way to drag a node through it. `map-scrim` is
         the one piece of CSS left, in assets/maplibre-overrides.css, because
         `backdrop-filter` has no Tailwind utility and this is DOM-only. -->
    <StateMessage
      v-if="$slots.overlay || (emptyMessage && geo && geo.nodes.features.length === 0)"
      variant="fill"
      :icon="MapPinOff"
      :class="[
        'absolute inset-0 z-raised',
        $slots.overlay ? 'map-scrim' : 'bg-surface',
      ]"
      data-testid="map-overlay"
    >
      <slot name="overlay">
        No nodes with coordinates to display.
        <span class="block text-2xs text-text-faint">
          Add latitude and longitude to your nodes.
        </span>
      </slot>
    </StateMessage>
    <div ref="container" class="h-full w-full" />
  </div>
</template>
