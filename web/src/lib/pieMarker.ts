/**
 * Donut markers for the map.
 *
 * MapLibre has no pie mark and no way to build one from paint properties, so a
 * node showing composition is an SVG in a `maplibregl.Marker` — the same shape as
 * Mapbox's own donut-cluster example, and the reason it works is that a marker is
 * ordinary DOM that MapLibre keeps positioned for us.
 *
 * The geometry is here, pure and tested, rather than inline in the component: an
 * arc path with the sweep flag computed wrongly draws a wedge inside out, which
 * is a picture of a model that is simply false, and it is far easier to check a
 * path string than a canvas.
 */
import type { PieSlice } from "./mapValues";

/** A slice, resolved to angles and a colour. */
export interface Wedge {
  key: string;
  value: number;
  /** Fraction of the whole, 0–1. */
  share: number;
  color: string;
  path: string;
}

/**
 * A point on the circle, in SVG user units with the origin at the centre.
 *
 * Angles run clockwise from twelve o'clock, which is where a reader expects a pie
 * to start. SVG's y axis points down, hence the sine on y without a negation.
 */
function point(radius: number, fraction: number): [number, number] {
  const angle = fraction * 2 * Math.PI - Math.PI / 2;
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * The path for one ring segment, between two fractions of the whole.
 *
 * A full circle cannot be drawn as a single arc — start and end coincide, and the
 * renderer draws nothing at all — so a segment covering everything becomes two
 * half arcs. That case is not hypothetical: a node with one technology is the
 * common case on a small model.
 */
export function wedgePath(
  from: number,
  to: number,
  outer: number,
  inner: number,
): string {
  if (to - from >= 1) {
    const ring = (radius: number, sweep: number) =>
      `M 0 ${round(-radius)} A ${round(radius)} ${round(radius)} 0 1 ${sweep} 0 ${round(radius)} ` +
      `A ${round(radius)} ${round(radius)} 0 1 ${sweep} 0 ${round(-radius)}`;
    // The hole is drawn the other way round so the even-odd fill leaves it empty.
    return `${ring(outer, 1)} ${ring(inner, 0)} Z`;
  }

  const large = to - from > 0.5 ? 1 : 0;
  const [outerStartX, outerStartY] = point(outer, from);
  const [outerEndX, outerEndY] = point(outer, to);
  const [innerEndX, innerEndY] = point(inner, to);
  const [innerStartX, innerStartY] = point(inner, from);

  return [
    `M ${round(outerStartX)} ${round(outerStartY)}`,
    `A ${round(outer)} ${round(outer)} 0 ${large} 1 ${round(outerEndX)} ${round(outerEndY)}`,
    `L ${round(innerEndX)} ${round(innerEndY)}`,
    `A ${round(inner)} ${round(inner)} 0 ${large} 0 ${round(innerStartX)} ${round(innerStartY)}`,
    "Z",
  ].join(" ");
}

/**
 * Resolves a node's slices into drawable wedges.
 *
 * Slices with no colour of their own fall back to the supplied default rather
 * than being dropped: a technology the server had no colour for still occupies
 * its share of the node, and leaving it out would silently inflate every other
 * wedge.
 */
export function wedges(
  slices: PieSlice[],
  outer: number,
  inner: number,
  fallbackColor: string,
): Wedge[] {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) return [];

  let cursor = 0;
  return slices.map((slice) => {
    const share = slice.value / total;
    const wedge: Wedge = {
      key: slice.key,
      value: slice.value,
      share,
      color: slice.color ?? fallbackColor,
      path: wedgePath(cursor, cursor + share, outer, inner),
    };
    cursor += share;
    return wedge;
  });
}

/**
 * The whole donut, as an SVG string.
 *
 * A string rather than constructed nodes because a marker's element is replaced
 * wholesale on every data change, and `innerHTML` on a detached element is both
 * shorter and faster than the equivalent `createElementNS` sequence. Nothing here
 * is user-supplied except technology names, which are interpolated only into a
 * `<title>` and escaped on the way.
 */
export function donutSvg(
  slices: PieSlice[],
  options: {
    radius: number;
    /** Ring thickness as a fraction of the radius. */
    thickness?: number;
    stroke: string;
    strokeWidth: number;
    fallbackColor: string;
    label?: string;
  },
): string {
  const { radius, thickness = 0.55, stroke, strokeWidth, fallbackColor } = options;
  const inner = radius * (1 - thickness);
  const drawn = wedges(slices, radius, inner, fallbackColor);
  const size = Math.ceil((radius + strokeWidth) * 2);
  const half = size / 2;

  const paths = drawn
    .map(
      (wedge) =>
        `<path d="${wedge.path}" fill="${wedge.color}" fill-rule="evenodd" />`,
    )
    .join("");

  const title = options.label ? `<title>${escapeText(options.label)}</title>` : "";

  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" ` +
    `xmlns="http://www.w3.org/2000/svg">${title}` +
    `<g transform="translate(${half} ${half})">` +
    `<circle r="${round(radius)}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" />` +
    paths +
    `<circle r="${round(inner)}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" />` +
    `</g></svg>`
  );
}

/** The five characters that would otherwise close the tag we are inside. */
export function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
