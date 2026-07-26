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
 * and costs a `v-model` indirection on every field.
 */

/** A 24px text/number/select control that fills its column. */
export const FIELD =
  "h-6 w-full min-w-0 rounded-xs border border-input bg-surface px-1.5 text-sm outline-none focus-visible:border-ring disabled:opacity-50";

/** The monospace label above a field, matching the key it edits. */
export const FIELD_LABEL = "font-mono text-xs text-text-dim";

/** A section heading inside a form. */
export const SECTION_HEADING =
  "text-2xs font-semibold uppercase tracking-wide text-text-faint";

/** A bordered card wrapping one section of a form. */
export const SECTION = "flex flex-col gap-2 rounded-sm border border-border p-2";

/** The primary action in an editor toolbar. */
export const PRIMARY_BUTTON =
  "inline-flex h-6 items-center gap-1.5 rounded-sm bg-primary px-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50";

/** A quiet toolbar or row action. */
export const GHOST_BUTTON =
  "inline-flex h-6 items-center gap-1.5 rounded-sm px-2 text-sm text-text-dim hover:bg-hover hover:text-foreground disabled:opacity-50";

/** A square icon-only button, for row-level add/remove. */
export const ICON_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-xs text-text-faint hover:bg-hover hover:text-foreground";

/** The same, for something destructive. */
export const DANGER_ICON_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-xs text-text-faint hover:bg-danger-soft hover:text-danger-text";
