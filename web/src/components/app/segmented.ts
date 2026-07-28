/**
 * One rule for "which of these is selected".
 *
 * There were five: the sidebar's segmented box (a soft fill *and* a separate 2px
 * bar, using the codebase's only two `!important` utilities), the tab bar (a
 * surface fill and an underline breaking through the strip border), the run
 * sub-tabs (the same underline but inset by 4px and sitting on the border rather
 * than through it), the config pane's 20px `bg-active` pills, and a real
 * ToggleGroup. Same question, five answers.
 *
 * The rule, decided by what the control *does* rather than by taste:
 *
 *   A segmented control that NAVIGATES — that changes what the region next to it
 *   shows — is CONTINUOUS with that region: the active segment takes the region's
 *   own background and its bottom hairline is erased, so the two read as one
 *   surface. Its label and icon go accent-coloured. One that SETS A VALUE stays a
 *   discrete control and marks its selection with a soft accent wash instead.
 *
 * The seam is what makes it work, and it is one pixel: the strip carries a
 * `border-b`, and the active segment paints a 1px bridge of the region's colour
 * over that border at `-bottom-px`. Every other segment keeps the line, so the
 * active one appears to open into the content below it — the tab-bar idiom Zed
 * and most editors use, and the reason no underline is needed to say which is
 * which.
 *
 * Colour, not a bar, carries the state. An accent underline says "this one" from
 * the edge; accent text says it at the label, which is where the eye already is,
 * and it costs no geometry in a 28px strip. Lucide icons stroke with
 * `currentColor`, so the icon follows the label for free.
 */

export const SEGMENT_BASE =
  "group relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap px-2 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/** Navigation: accent label and icon, plus the seam. */
export const SEGMENT_NAV_ACTIVE =
  "data-[active]:font-medium data-[active]:text-accent-text data-[active]:after:absolute data-[active]:after:inset-x-0 data-[active]:after:-bottom-px data-[active]:after:h-px";

/**
 * Which surface the active segment opens into.
 *
 * Whatever sits below the strip: `surface` for a tab bar over an editor or a
 * card, `panel` for the sidebar's section switcher, which opens onto more
 * sidebar. Both hold in either theme — the active segment is one step forward of
 * its strip in light *and* dark, because the ramps invert together.
 *
 * `none` is for a switcher with no one surface beneath it; see below.
 */
export const SEGMENT_NAV_SEAM = {
  surface: "data-[active]:bg-surface data-[active]:after:bg-surface",
  panel: "data-[active]:bg-panel data-[active]:after:bg-panel",
  /**
   * No seam — accent colour alone.
   *
   * For a *secondary* switcher living inside a pane rather than a tab bar
   * spanning one: the run sub-tabs, the config pane's written/solved pair. There
   * is no single surface under those strips to open into (the results view is a
   * grey filter rail beside white cards), so a filled active segment reads as a
   * chip floating on the strip rather than as continuity — which is worse than
   * the underline it replaced. Colour still carries the state.
   */
  none: "",
} as const;

/** Setting a value: the soft accent wash selection means everywhere else. */
export const SEGMENT_VALUE_ACTIVE =
  "rounded-sm data-[active]:bg-accent-soft data-[active]:font-medium data-[active]:text-accent-text";

/** Segment heights, matching the strip they sit in via the density contract. */
export const SEGMENT_SIZE = {
  sm: "h-7",
  md: "h-8",
} as const;
