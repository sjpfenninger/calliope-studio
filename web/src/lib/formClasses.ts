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
 * **A form is all sans.** Mono means code — text the user could paste into a
 * file or a terminal — and is written once, as `CODE_BLOCK`. A key needs no
 * second typeface to mark it: it is the thing in the 9rem gutter. A name or a
 * path *inside a sentence* has no position to speak for it, and gets
 * `IDENTIFIER`.
 */

/**
 * The four control heights, and the only names for them.
 *
 * One prop name meant three heights before this. `size="sm"` was 24px on
 * `ui/button`, `SelectTrigger` and `ToggleGroup`, 20px on `TooltipButton`, and
 * 28px on `PanelHeader` and `Segmented` — the `ui/` family and the `app/` family
 * offset by a full step, and `TooltipButton` offset the other way. Writing
 * `size="sm"` on every control in one header therefore produced 20, 24 and 28px
 * side by side, which is exactly what four figure headers did.
 *
 * Named for the height rather than relative to a component, so `sm` is 24px
 * wherever it is written.
 */
export const CONTROL_HEIGHT = {
  /** 20px — an affordance inside a 24px row, or a control in a 28px strip. */
  xs: "h-5",
  /** 24px — a field, a row action, a control in a 32px strip. */
  sm: "h-6",
  /** 28px — a nested strip, or a standalone action in a dialog or page header. */
  md: "h-7",
  /** 32px — a primary chrome strip. */
  lg: "h-8",
} as const;

export type ControlSize = keyof typeof CONTROL_HEIGHT;

/** One faded state, at one value — the fields and the icon buttons disagreed. */
export const DISABLED = "disabled:opacity-50";

/**
 * A block of code: a solver log, a snapshot file, a YAML fragment, a traceback.
 *
 * The only place in the app that writes `font-mono`, which `design.test.ts`
 * enforces. The leading is the token Monaco is handed, so every code surface
 * shares one line height.
 */
export const CODE_BLOCK =
  "font-mono text-sm leading-[var(--cg-code-line-height)]";

/**
 * An identifier inside a sentence: a path, a key, a technology name.
 *
 * The same chip `assets/markdown.css` draws around inline `code`, so a path in
 * a dialog and one in a rendered README look like one thing.
 */
export const IDENTIFIER = "rounded-xs bg-surface-2 px-1 text-text-dim";

/** A 24px text/number/select control that fills its column. */
export const FIELD =
  `h-6 w-full min-w-0 rounded-sm border border-input bg-surface px-1.5 text-sm transition-colors focus-visible:border-ring ${DISABLED}`;

/**
 * The same at 20px, for a control inside a 24px row.
 *
 * It existed twice as `cn(FIELD, "h-5 …")` — in the log filter and the run
 * rename field — with different extra classes each time, and both kept `FIELD`'s
 * `rounded-sm`, which is the radius a *24px* control gets. That is the failure
 * `DANGER_ICON_BUTTON_SM` was added for: 20px at the wrong roundness.
 */
export const FIELD_SM =
  `h-5 w-full min-w-0 rounded-xs border border-input bg-surface px-1 text-2xs transition-colors focus-visible:border-ring ${DISABLED}`;

/** The label naming the key a field edits. */
export const FIELD_LABEL = "text-sm text-text-dim";

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
  `inline-flex h-6 items-center gap-1.5 rounded-sm border border-accent-border bg-accent-soft px-2 text-sm font-medium text-accent-text transition-colors hover:bg-accent-soft-2 ${DISABLED}`;

/**
 * The 28px tier: a dialog footer's action, or a button standing alone on a page.
 *
 * These existed only as `cn(PRIMARY_BUTTON, "h-7 px-3")` written at the call
 * site — six times at `px-3` and twice at `px-2.5`, so the same button was two
 * widths across four files, and neither matched the `px-2.5` that
 * `ui/dialog/DialogFooter`'s own built-in Close button renders at. `px-2.5` wins
 * because the primitive already said so.
 */
export const PRIMARY_BUTTON_MD =
  `inline-flex h-7 items-center gap-1.5 rounded-sm border border-accent-border bg-accent-soft px-2.5 text-sm font-medium text-accent-text transition-colors hover:bg-accent-soft-2 ${DISABLED}`;

/** The neutral 28px action — the "Cancel" beside `PRIMARY_BUTTON_MD`. */
export const SECONDARY_BUTTON_MD =
  `inline-flex h-7 items-center gap-1.5 rounded-sm border border-border px-2.5 text-sm transition-colors hover:bg-hover ${DISABLED}`;

/** The destructive 28px action, for a confirmation dialog's own button. */
export const DANGER_BUTTON_MD =
  `inline-flex h-7 items-center gap-1.5 rounded-sm border border-danger-soft bg-danger-soft px-2.5 text-sm font-medium text-danger-text transition-colors hover:border-destructive hover:bg-destructive hover:text-destructive-foreground ${DISABLED}`;

/** A quiet toolbar or row action. */
export const GHOST_BUTTON =
  `inline-flex h-6 items-center gap-1.5 rounded-sm px-2 text-sm text-text-dim transition-colors hover:bg-hover hover:text-foreground ${DISABLED}`;

/** A neutral, bordered action — the "Cancel" beside a primary button. */
export const SECONDARY_BUTTON =
  `inline-flex h-6 items-center gap-1.5 rounded-sm border border-border px-2 text-sm transition-colors hover:bg-hover ${DISABLED}`;

/**
 * A destructive primary action, for a confirmation dialog.
 *
 * Tinted at rest like the primary action, but it goes *solid* on hover — the
 * one place in the app where a filled saturated block is earned, because the
 * pointer is already on the button that deletes something.
 */
export const DANGER_BUTTON =
  `inline-flex h-6 items-center gap-1.5 rounded-sm border border-danger-soft bg-danger-soft px-2 text-sm font-medium text-danger-text transition-colors hover:border-destructive hover:bg-destructive hover:text-destructive-foreground ${DISABLED}`;

/**
 * A bare text action at the micro step: "All", "None", "Reset", "Clear".
 *
 * There were five copies of this and none of them shared a definition. Four were
 * byte-identical across the three sidebar filter panels — the most-repeated
 * literal class string in the tree — one inherited its size from the footer it
 * sat in and set no colour at all, and one used `text-accent-text`. No height on
 * any of them, so the row decided.
 */
export const TEXT_BUTTON_SM =
  `rounded-xs px-1 text-2xs text-text-faint transition-colors hover:bg-hover hover:text-foreground ${DISABLED}`;

/**
 * A word inside a run of text that opens something — the template a field
 * inherits from, named in its provenance marker.
 *
 * Not `TEXT_BUTTON_SM`, which is the *standalone* micro action ("All", "Reset")
 * and is therefore both padded and `text-text-faint` — the disabled step, which
 * tokens.css says is never for real text. Here the word is the content, and
 * making the clickable copy of it fainter than the plain copy beside it gets the
 * signal exactly backwards.
 *
 * So: no colour and no padding of its own, so it sits in its sentence and
 * inherits the annotation's tone, with a dotted underline to say it is a target
 * and a step *up* in contrast on hover.
 */
export const INLINE_LINK =
  "rounded-xs underline decoration-dotted underline-offset-2 transition-colors hover:bg-hover hover:text-foreground";

/** A square icon-only button, for row-level add/remove. */
export const ICON_BUTTON =
  `grid size-6 shrink-0 place-items-center rounded-sm text-text-faint transition-colors hover:bg-hover hover:text-foreground ${DISABLED}`;

/** The same at 20px, for an inline affordance inside a 24px row. */
export const ICON_BUTTON_SM =
  `grid size-5 shrink-0 place-items-center rounded-xs text-text-faint transition-colors hover:bg-hover hover:text-foreground ${DISABLED}`;

/** The same, for something destructive. */
export const DANGER_ICON_BUTTON =
  `grid size-6 shrink-0 place-items-center rounded-sm text-text-faint transition-colors hover:bg-danger-soft hover:text-danger-text ${DISABLED}`;

/**
 * Destructive at 20px, for a remove affordance inside a 24px row.
 *
 * The fourth corner of the size × tone square, and the one the scenarios editor
 * was reaching for when it wrote `cn(DANGER_ICON_BUTTON, "size-5")` — which kept
 * the 3px radius a 24px control gets and so was 20px at the wrong roundness.
 */
export const DANGER_ICON_BUTTON_SM =
  `grid size-5 shrink-0 place-items-center rounded-xs text-text-faint transition-colors hover:bg-danger-soft hover:text-danger-text ${DISABLED}`;
