/**
 * The geometry a figure reserves around its plot area.
 *
 * These were four loose numbers inside `buildOption` — `grid.bottom: 72`, the
 * zoom slider's `height: 16` and `bottom: 28`, and the legend's `bottom: 0` —
 * which had to add up or the slider drew over the legend, and nothing said so.
 * `GRID_BOTTOM` is now derived, so moving the slider cannot silently break it.
 */

/** The scrolling legend, along the bottom edge. */
export const LEGEND_H = 24;

/** The zoom slider, above the legend. */
export const ZOOM_H = 16;

/** Breathing room between the slider and the plot area. */
export const ZOOM_GAP = 12;

/** Where the slider sits, measured from the bottom of the canvas. */
export const ZOOM_BOTTOM = LEGEND_H + 4;

/** Room below the plot area for both of them. */
export const GRID_BOTTOM = ZOOM_BOTTOM + ZOOM_H + ZOOM_GAP;

/**
 * The same geometry with the legend taken out.
 *
 * A chart whose bars are coloured by their category has no legend — colour maps
 * to the axis, not to a series — and it should get that strip back as plot area
 * rather than leave a gap where the legend used to be. Derived here for the same
 * reason `GRID_BOTTOM` is: a second number that merely happens to agree is one
 * that stops agreeing.
 */
export const zoomBottom = (withLegend: boolean): number =>
  withLegend ? ZOOM_BOTTOM : 4;

export const gridBottom = (withLegend: boolean): number =>
  zoomBottom(withLegend) + ZOOM_H + ZOOM_GAP;

/**
 * Room above the plot area.
 *
 * 8px, not 32: the y-axis *title* used to be rendered inside the canvas above
 * the axis, and this is the space that reserved. The title is a DOM panel
 * header now, which gives every chart 24px of plot area back and puts the text
 * on the app's type scale rather than ECharts'.
 *
 * The unit is the one thing that did come back into the canvas, and only when
 * there is one to show — "GWh" belongs against the numbers it qualifies, not in
 * a header three elements away from them. So the room is derived from whether
 * the axis is named, in the same way `gridBottom` is derived from the legend
 * rather than being a second number that has to agree with it.
 */
export const GRID_TOP = 8;

export const gridTop = (withAxisName: boolean): number =>
  withAxisName ? GRID_TOP + 16 : GRID_TOP;

export const GRID_LEFT = 8;
export const GRID_RIGHT = 16;
