/**
 * The handful of control shapes the structured editors are built from.
 *
 * These editors are dense forms of near-identical rows, and they were five
 * separate `<style scoped>` blocks saying the same thing in slightly different
 * numbers. One place, so a field is the same height in the techs editor and the
 * data-tables editor — which it previously was not.
 *
 * Plain strings rather than components: the controls are bare `<input>` and
 * `<select>` elements, because a wrapper around a native input buys nothing here
 * and costs a `v-model` indirection on every field. (`components/ui/input` is
 * deliberately absent for the same reason — a second, 28px definition of a text
 * field is exactly how the two systems forked in the first place.)
 *
 * Radius follows the size contract rather than the author: everything 24–32px is
 * `rounded-sm`, and only things 20px and under are `rounded-xs`. These used to
 * disagree with each other inside this very file.
 *
 * **Keys are monospace, values are sans.** A key is a literal YAML identifier, so
 * it gets the mono face at the mono step — 11px, because IBM Plex Mono at 11px
 * optically matches Inter at 12px (see the type scale in `style.css`). Everything
 * else — a value, a source annotation, a badge, prose — is sans. The editors used
 * to break this in both directions: the inherited-values box rendered headings,
 * values and badges alike in 10px mono, and the overrides editor put a mono path
 * in a 12px field. Mono at 10px reads as a footnote in a different typeface,
 * which is precisely what a user notices without being able to name it.
 */

/** A 24px text/number/select control that fills its column. */
export const FIELD =
  "h-6 w-full min-w-0 rounded-sm border border-input bg-surface px-1.5 text-sm transition-colors focus-visible:border-ring disabled:opacity-50";

/**
 * The same, for a control whose *value* is an identifier: a parameter name, a
 * dotted override path. Mono at the mono step, rather than `FIELD`'s 12px sans.
 */
export const FIELD_MONO =
  "h-6 w-full min-w-0 rounded-sm border border-input bg-surface px-1.5 font-mono text-xs transition-colors focus-visible:border-ring disabled:opacity-50";

/** The monospace label naming the key a field edits. */
export const FIELD_LABEL = "font-mono text-xs text-text-dim";

/**
 * One field: its key in a fixed gutter, its control beside it.
 *
 * Label-left rather than label-above, and a gutter rather than `auto`, because
 * these forms are columns of near-identical short values — a coordinate, an
 * identifier, an enum — and stacking each one over a full-width box spent 44px
 * of a splitter-height pane on 24px of control. A *fixed* 9rem means every value
 * in the form starts at the same x, including the parameter rows whose key is
 * itself an input, so the whole form reads down one seam.
 *
 * 9rem is 144px, which is what the parameter-key inputs were already using.
 */
export const FIELD_ROW = "grid grid-cols-[9rem_minmax(0,1fr)] gap-1.5";

/**
 * The same, for keys that are paths rather than names.
 *
 * An override's key is a dotted path into the whole config —
 * `config.solve.spores.tracking_parameter` — and at 9rem two settings that
 * differ only in their last segment truncate to the same string, which is worse
 * than the misalignment a second gutter width costs.
 */
export const FIELD_ROW_WIDE = "grid grid-cols-[16rem_minmax(0,1fr)] gap-1.5";

/**
 * How wide the control is, which is the other half of the same problem: a
 * latitude does not need the 1150px the map-detail pane is happy to give it.
 * The row owns the width and `FIELD` stays `w-full` inside it, so there is still
 * only one definition of a text field.
 */
export const FIELD_WIDTH = {
  /** 64px — a coordinate, a count, anything `type="number"`. */
  num: "w-16 shrink-0",
  /** 144px — an identifier, a template name, a select. */
  short: "w-36 shrink-0",
  /**
   * 256px — a free parameter's value.
   *
   * Bounded rather than filling, because a parameter is *usually* `0.4` and
   * occasionally `Concentrating solar power`: 256px holds the sentence and stops
   * the number from being handed 860px of a wide pane. Fixed rather than a
   * `max-w`, so the provenance markers after it line up in a column of their own
   * instead of sitting at a ragged right edge.
   */
  value: "w-64 shrink-0",
  /** The rest of the row — free text, a comma-separated list, a path. */
  fill: "min-w-0 flex-1",
  /** No width at all, for a control that sizes itself: a switch. */
  auto: "shrink-0",
} as const;

/** How wide a field's control should be. */
export type FieldWidth = keyof typeof FIELD_WIDTH;

/** A section heading inside a form. */
export const SECTION_HEADING =
  "text-2xs font-semibold uppercase tracking-wide text-text-faint";

/** A bordered card wrapping one section of a form. */
export const SECTION = "flex flex-col gap-2 rounded-md border border-border p-2";

/**
 * The primary action in a toolbar: Save, Run, Open model.
 *
 * Tinted rather than a solid accent block. In this app saturated accent already
 * means *state* — a checked checkbox, an on switch, a dirty dot, a running
 * status, the progress hairline, the active tab's label — so a filled blue
 * button competes with all of it, and a toolbar that is 90% grey does not need
 * a saturated rectangle to make Save findable. The soft wash plus an accent
 * border and accent text is unmistakably the action without shouting, and it
 * keeps the loud end of the ramp meaning one thing.
 */
export const PRIMARY_BUTTON =
  "inline-flex h-6 items-center gap-1.5 rounded-sm border border-accent-border bg-accent-soft px-2 text-sm font-medium text-accent-text transition-colors hover:bg-accent-soft-2 disabled:opacity-50";

/** A quiet toolbar or row action. */
export const GHOST_BUTTON =
  "inline-flex h-6 items-center gap-1.5 rounded-sm px-2 text-sm text-text-dim transition-colors hover:bg-hover hover:text-foreground disabled:opacity-50";

/** A neutral, bordered action — the "Cancel" beside a primary button. */
export const SECONDARY_BUTTON =
  "inline-flex h-6 items-center gap-1.5 rounded-sm border border-border px-2 text-sm transition-colors hover:bg-hover disabled:opacity-50";

/**
 * A destructive primary action, for a confirmation dialog.
 *
 * Tinted at rest like the primary action, but it goes *solid* on hover — the
 * one place in the app where a filled saturated block is earned, because the
 * pointer is already on the button that deletes something.
 */
export const DANGER_BUTTON =
  "inline-flex h-6 items-center gap-1.5 rounded-sm border border-danger-soft bg-danger-soft px-2 text-sm font-medium text-danger-text transition-colors hover:border-destructive hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50";

/** A square icon-only button, for row-level add/remove. */
export const ICON_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-sm text-text-faint transition-colors hover:bg-hover hover:text-foreground disabled:opacity-40";

/** The same at 20px, for an inline affordance inside a 24px row. */
export const ICON_BUTTON_SM =
  "grid size-5 shrink-0 place-items-center rounded-xs text-text-faint transition-colors hover:bg-hover hover:text-foreground disabled:opacity-40";

/** The same, for something destructive. */
export const DANGER_ICON_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-sm text-text-faint transition-colors hover:bg-danger-soft hover:text-danger-text disabled:opacity-40";
