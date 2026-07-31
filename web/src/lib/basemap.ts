/**
 * The basemap, authored here rather than fetched pre-styled.
 *
 * Tiles come from **OpenFreeMap** (`tiles.openfreemap.org`): OpenMapTiles-schema
 * vector tiles with no API key, no signup and no request limit, MIT-licensed,
 * with weekly full-planet downloads for anyone who would rather self-host. That
 * is what makes it usable here — an energy model viewer that someone installs
 * locally must not require signing up for a tile service to see where its nodes
 * are, which is exactly why this was raster OpenStreetMap tiles before.
 *
 * Two things follow from vector rather than raster, and both are the point:
 *
 * - **Resolution independence.** Tiles carry geometry, not pixels, so MapLibre
 *   renders at the device pixel ratio and labels are glyph-crisp on a HiDPI
 *   screen. There is nothing to configure for it.
 * - **The map can finally obey the token system.** Every colour below is a
 *   `--cg-*` custom property, so the basemap is as achromatic as the rest of the
 *   surfaces and dark mode is a real style rather than a dimmed light one. The
 *   raster basemap could only be *drained* — `raster-saturation` and a brightness
 *   clamp — because MapLibre has no raster-invert.
 *
 * Deliberately minimal: land, water, parks, two levels of administrative
 * boundary, motorways at close zoom, and two levels of place label. A model's
 * geography is the figure; the basemap is ground, and every layer left out is a
 * layer that cannot compete with a node marker for attention.
 *
 * MapLibre's paint parser cannot read `oklch` — its bundle contains no reference
 * to it — so every value goes through `lib/cssColor` like the other non-DOM
 * renderers.
 */
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

import { resolvedColor } from "./cssColor";

/**
 * A paint property name `setPaintProperty` will accept.
 *
 * maplibre-gl 6 narrowed that parameter from `string` to a key of the style
 * spec's paint properties, which is the better type — a mistyped
 * `"line-colour"` is now a compile error rather than a layer that silently
 * keeps its old colour. Read off the method rather than imported by name:
 * `AllPaintProperties` lives in `@maplibre/maplibre-gl-style-spec`, which is a
 * transitive dependency, and pnpm does not hoist.
 */
type PaintProperty = Parameters<MapLibreMap["setPaintProperty"]>[1];

/** The vector source id, and what an error event names when tiles fail. */
export const VECTOR_SOURCE = "openmaptiles";

/** The keyless raster source kept as a fallback. See `RASTER_LAYER`. */
export const RASTER_SOURCE = "osm";

/** The raster fallback's layer, hidden unless the vector source fails. */
export const RASTER_LAYER = "osm";

/**
 * Every layer drawn from the vector source, in draw order.
 *
 * The `land` background is deliberately not among them: it has no source, so it
 * cannot fail, and leaving it up gives the raster fallback something to load
 * over instead of a flash of white.
 */
export const VECTOR_LAYERS = [
  "landcover",
  "water",
  "boundary-state",
  "boundary-country",
  "road-major",
  "place-city",
  "place-country",
] as const;

const VECTOR_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> ' +
  '&copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';

const RASTER_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * The only font stack OpenFreeMap serves glyphs for, and enough for a basemap
 * whose labels are meant to recede.
 */
const FONT = ["Noto Sans Regular"];

/**
 * English, then a Latin transliteration, then whatever the place calls itself.
 *
 * Three steps because they are three different things and only the first is a
 * translation: `name:en` is the English exonym where OpenStreetMap records one
 * (Munich, Cologne, Vienna), `name:latin` only transliterates the local name
 * into Latin script (München stays München, Москва becomes Moskva), and `name`
 * is the local name in the local script. Latin has to stay in the chain — a
 * great many places have no English name at all, and dropping to `name` for
 * those would put Cyrillic, Greek and Han glyphs on the map, none of which the
 * one font stack OpenFreeMap serves can draw.
 */
const LABEL: unknown = [
  "coalesce",
  ["get", "name:en"],
  ["get", "name:latin"],
  ["get", "name"],
];

/**
 * How hard to drain the raster fallback, per theme.
 *
 * Fully, in both: the vector basemap is greyscale by construction, and a
 * fallback that reintroduced a blue ocean would make the map's meaning depend on
 * whether the tiles happened to load. `-1` is complete desaturation, not merely a
 * lot of it — the previous −0.85 left the sea visibly blue.
 *
 * The rest is what raster still needs and vector does not: dark can only dim,
 * because MapLibre has no raster-invert.
 */
export const RASTER_PAINT = {
  light: {
    "raster-saturation": -1,
    "raster-contrast": -0.15,
    "raster-brightness-min": 0.12,
    "raster-brightness-max": 0.97,
    "raster-opacity": 0.9,
  },
  dark: {
    "raster-saturation": -1,
    "raster-contrast": -0.1,
    "raster-brightness-min": 0,
    "raster-brightness-max": 0.34,
    "raster-opacity": 0.75,
  },
} as const;

/**
 * Every basemap paint property that follows the theme.
 *
 * Returned as a table rather than applied here, so `ModelMap` can loop it on a
 * theme change with `setPaintProperty` and never call `setStyle` — which would
 * destroy the node and link sources along with it.
 */
export function basemapPaint(): [layer: string, property: PaintProperty, value: string][] {
  // Each fallback is the token's own light value, so it is chroma 0 like the
  // token: a first paint that beats the stylesheet must not draw a blue ocean.
  // `lib/tokens.test.ts` keeps them in step.
  const land = resolvedColor("--cg-map-land", "#f3f3f3");
  const landAlt = resolvedColor("--cg-map-land-alt", "#ebebeb");
  const water = resolvedColor("--cg-map-water", "#dcdcdc");
  const boundary = resolvedColor("--cg-map-boundary", "#a4a4a4");
  const road = resolvedColor("--cg-map-road", "#d4d4d4");
  const label = resolvedColor("--cg-map-label", "#5d5d5d");
  const halo = resolvedColor("--cg-map-label-halo", "#fcfcfc");

  return [
    ["land", "background-color", land],
    ["landcover", "fill-color", landAlt],
    ["water", "fill-color", water],
    ["boundary-state", "line-color", boundary],
    ["boundary-country", "line-color", boundary],
    ["road-major", "line-color", road],
    ["place-city", "text-color", label],
    ["place-city", "text-halo-color", halo],
    ["place-country", "text-color", label],
    ["place-country", "text-halo-color", halo],
  ];
}

/**
 * The style, built from the tokens currently in force.
 *
 * A function rather than a constant because it resolves custom properties, which
 * needs a document — and because the theme in force when the map mounts decides
 * the initial colours.
 */
export function basemapStyle(): StyleSpecification {
  const paint = new Map(
    basemapPaint().map(([layer, property, value]) => [`${layer}.${property}`, value]),
  );
  const value = (key: string) => paint.get(key) as string;

  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      [VECTOR_SOURCE]: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
        attribution: VECTOR_ATTRIBUTION,
      },
      // Declared but never drawn unless the vector tiles fail. A layer with
      // `visibility: none` fetches nothing, so this costs one entry in the style
      // and no requests — which is what makes the fallback a visibility flip
      // rather than a `setStyle`.
      [RASTER_SOURCE]: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: RASTER_ATTRIBUTION,
      },
    },
    layers: [
      {
        id: "land",
        type: "background",
        paint: { "background-color": value("land.background-color") },
      },
      {
        id: RASTER_LAYER,
        type: "raster",
        source: RASTER_SOURCE,
        layout: { visibility: "none" },
        paint: { ...RASTER_PAINT.light },
      },
      {
        id: "landcover",
        type: "fill",
        source: VECTOR_SOURCE,
        "source-layer": "park",
        paint: {
          "fill-color": value("landcover.fill-color"),
          "fill-opacity": 0.7,
        },
      },
      {
        id: "water",
        type: "fill",
        source: VECTOR_SOURCE,
        "source-layer": "water",
        // Ice shelves read as land, not sea, and drawing them as water puts a
        // false coastline across Antarctica.
        filter: ["!=", ["get", "class"], "ice"],
        paint: { "fill-color": value("water.fill-color") },
      },
      {
        id: "boundary-state",
        type: "line",
        source: VECTOR_SOURCE,
        "source-layer": "boundary",
        minzoom: 4,
        filter: [
          "all",
          [">=", ["get", "admin_level"], 3],
          ["<=", ["get", "admin_level"], 4],
          ["!=", ["get", "maritime"], 1],
        ],
        layout: { "line-join": "round" },
        paint: {
          "line-color": value("boundary-state.line-color"),
          "line-width": 0.5,
          "line-opacity": 0.5,
          "line-dasharray": [3, 2],
        },
      },
      {
        id: "boundary-country",
        type: "line",
        source: VECTOR_SOURCE,
        "source-layer": "boundary",
        // Maritime boundaries are the ones drawn out at sea; without this a
        // country is ringed twice, once at its coast and once well offshore.
        filter: [
          "all",
          ["<=", ["get", "admin_level"], 2],
          ["!=", ["get", "maritime"], 1],
        ],
        layout: { "line-join": "round" },
        paint: {
          "line-color": value("boundary-country.line-color"),
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.6, 8, 1.2],
          "line-opacity": 0.8,
        },
      },
      {
        id: "road-major",
        type: "line",
        source: VECTOR_SOURCE,
        "source-layer": "transportation",
        // Only at the zoom where a model's nodes are a city apart rather than a
        // country apart, and only the two classes that carry any orientation.
        minzoom: 7,
        filter: ["match", ["get", "class"], ["motorway", "trunk"], true, false],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": value("road-major.line-color"),
          "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.4, 14, 2],
        },
      },
      {
        id: "place-city",
        type: "symbol",
        source: VECTOR_SOURCE,
        "source-layer": "place",
        minzoom: 4,
        filter: ["match", ["get", "class"], ["city", "town"], true, false],
        layout: {
          "text-field": LABEL as never,
          "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 10, 12],
          "text-max-width": 7,
          "text-padding": 4,
        },
        paint: {
          "text-color": value("place-city.text-color"),
          "text-halo-color": value("place-city.text-halo-color"),
          "text-halo-width": 1,
        },
      },
      {
        id: "place-country",
        type: "symbol",
        source: VECTOR_SOURCE,
        "source-layer": "place",
        maxzoom: 8,
        filter: ["==", ["get", "class"], "country"],
        layout: {
          "text-field": LABEL as never,
          "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 2, 10, 6, 13],
          "text-transform": "uppercase",
          "text-letter-spacing": 0.08,
          "text-max-width": 8,
          "text-padding": 6,
        },
        paint: {
          "text-color": value("place-country.text-color"),
          "text-halo-color": value("place-country.text-halo-color"),
          "text-halo-width": 1.25,
          "text-opacity": 0.85,
        },
      },
    ],
  } as StyleSpecification;
}
