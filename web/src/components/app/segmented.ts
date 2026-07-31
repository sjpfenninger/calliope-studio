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
 * A bridge at `-bottom-px` is outside the strip's padding box, which is fine
 * until the strip scrolls: `overflow-x: auto` makes `overflow-y` compute to
 * `auto` as well, and the clip takes the bridge with it. `TabBar` scrolls, so
 * its seam was drawn and thrown away for as long as it existed — the one place
 * the rule is most visible was the one place it never applied. A strip that
 * scrolls takes `SEGMENT_STRIP_LINE_SCROLLED` below instead of a `border-b`.
 *
 * Colour, not a bar, carries the state. An accent underline says "this one" from
 * the edge; accent text says it at the label, which is where the eye already is,
 * and it costs no geometry in a 28px strip. Lucide icons stroke with
 * `currentColor`, so the icon follows the label for free.
 */

export const SEGMENT_BASE =
  "group relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap px-2 text-sm text-text-muted transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/**
 * The strip's own bottom hairline, for a strip that scrolls.
 *
 * Same line as `border-b border-border`, moved one pixel up into the padding box
 * so that it is inside the scroller's clip and the active segment's own
 * background covers it — which is what a bridge cannot do there. An inset shadow
 * rather than a background gradient because it paints above the element's
 * background and below every child, and because it does not scroll with the
 * content: a gradient on a scroller works too, but says none of that.
 *
 * The one arbitrary shadow in the app, and deliberately not one of the mapped
 * `--cg-shadow-*` steps: it is a hairline, not elevation.
 */
export const SEGMENT_STRIP_LINE_SCROLLED = "shadow-[inset_0_-1px_0_var(--color-border)]";

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

/**
 * The rest of the tab shape: the active segment's two vertical edges.
 *
 * The seam opens the *bottom* of the active segment into the region below it. On
 * its own that leaves a segment with no sides — a fill and an accent label said
 * where it began and ended, which reads as a tinted word rather than as a tab
 * the content hangs off. Full-strength edges left and right, meeting the strip's
 * own `border-b` at the two corners the seam does not bridge, are what close it.
 *
 * Sides only, never a top. Whatever bounds the strip above already draws that
 * line, and a second one against it is the 2px seam this rule exists to avoid.
 *
 * Nothing here changes a width on activation, in either variant: 2px appearing
 * under the pointer would step the whole strip sideways every time the selection
 * moved. Only colours change.
 */

/**
 * For a strip that draws no rules between its segments — the sidebar switcher,
 * whose segments grow from their content and touch.
 *
 * Every segment carries the two widths transparently; only the active one
 * colours them. The outer two are dropped because the strip is full-bleed: the
 * first segment's left edge is the container's own and the last one's right edge
 * is the boundary beside it, so drawn, they would double both.
 */
export const SEGMENT_NAV_EDGES =
  "border-x border-transparent first:border-l-0 last:border-r-0 data-[active]:border-border";

/**
 * For a strip that already rules between its segments — `TabBar`, where every tab
 * carries a hairline separator on its right.
 *
 * Those rules are in exactly the two places the edges go, so the active tab needs
 * no borders of its own: its own separator and the one belonging to the tab
 * *before* it go full strength, and everything else stays subtle. Hence the
 * `:has(+ …)`, which is the only way to reach a previous sibling — and why this
 * cannot simply be the variant above: adding a left border to every tab would put
 * it hard against the neighbour's separator and draw the boundary twice.
 *
 * An active *first* tab gets no left edge, for the same reason the flush variant
 * drops its outer two: the shell's own boundary is already there.
 */
export const SEGMENT_NAV_EDGES_RULED =
  "border-r border-border-subtle data-[active]:border-r-border [&:has(+[data-active])]:border-r-border";

/** Setting a value: the soft accent wash selection means everywhere else. */
export const SEGMENT_VALUE_ACTIVE =
  "rounded-sm data-[active]:bg-accent-soft data-[active]:font-medium data-[active]:text-accent-text";

/**
 * The same wash, square, for a switcher that fills its strip top to bottom.
 *
 * A radius is what makes a selection read as a *pill floating on* the strip, and
 * that is right while there is strip visible above and below it to float on. At
 * `size="fill"` there is none: the wash meets the hairline at both edges, so a
 * rounded corner leaves four wedges of strip colour biting into it and the block
 * reads as slightly misaligned rather than as deliberately round. Colour still
 * carries the state — only the shape changes.
 */
export const SEGMENT_VALUE_ACTIVE_FILL = "rounded-none";

/**
 * Segment heights, matching the strip they sit in via the density contract.
 *
 * `fill` is the exception, and it is a measurement rather than a step: the strip
 * a switcher fills is `h-7` *including* its `border-b`, so its content box is
 * 27px and no named height fits it. `h-7` segments in an `h-7` strip overflowed
 * by that pixel, and `items-center` splits an overflow — so the selection sat
 * half a pixel over the hairline above it and half a pixel over the one below,
 * which is what a slightly smudged edge on both sides actually is. `h-full`
 * measures the box instead of guessing at it.
 */
export const SEGMENT_SIZE = {
  /** 28px, for a strip that is 32px. */
  md: "h-7",
  /** 32px, for a strip that is the full chrome height. */
  lg: "h-8",
  fill: "h-full",
} as const;
