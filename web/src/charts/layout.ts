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
 * Room above the plot area.
 *
 * 8px, not 32: the y-axis name used to be rendered *inside* the canvas above the
 * axis, and this is the space that reserved. The title is a DOM panel header
 * now, which gives every chart 24px of plot area back and puts the text on the
 * app's type scale rather than ECharts'.
 */
export const GRID_TOP = 8;

export const GRID_LEFT = 8;
export const GRID_RIGHT = 16;
