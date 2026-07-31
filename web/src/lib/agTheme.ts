import { themeQuartz } from "ag-grid-community";

/**
 * The single AG Grid theme, driven by the CSS design tokens.
 *
 * AG Grid is the one renderer here that needs no colour resolution: its Theming
 * API emits params as `--ag-*` custom properties and does its own mixing in CSS,
 * so `var(--cg-*)` passes straight through and `oklch` never has to be parsed in
 * JavaScript. That also means light and dark need **no JavaScript at all** — the
 * tokens re-declare themselves under the dark selector and the grid repaints.
 *
 * `browserColorScheme: "inherit"` picks up the `color-scheme` that
 * `stores/ui.ts` sets, so the grid's own native scrollbars and form controls
 * follow too.
 *
 * Do **not** put an `ag-theme-*` class on a grid element. Since v33 the Theming
 * API is the default and mixing the two logs AG Grid error #239 — which is
 * exactly what `CsvGridEditor.vue` used to do, with no stylesheet imported to
 * back the class up, so the grid silently rendered stock Quartz and ignored the
 * design system entirely.
 */
export const gridTheme = themeQuartz.withParams({
  browserColorScheme: "inherit",

  backgroundColor: "var(--cg-surface)",
  foregroundColor: "var(--cg-text)",
  accentColor: "var(--cg-accent)",
  borderColor: "var(--cg-border-subtle)",
  chromeBackgroundColor: "var(--cg-surface-2)",

  fontFamily: "var(--cg-font-sans)",
  fontSize: "var(--cg-font-size-sm)",
  // No `cellFontFamily`: columns line up on tabular figures, not on the face,
  // and `style.css` already gives `.ag-root-wrapper` `tabular-nums`.

  spacing: 4,
  rowHeight: "var(--cg-row-h)",
  headerHeight: "var(--cg-row-header-h)",
  cellHorizontalPadding: 8,

  borderRadius: "var(--cg-radius-sm)",
  // The grid fills a panel that already has its own border.
  wrapperBorderRadius: 0,
  wrapperBorder: false,
  headerRowBorder: { color: "var(--cg-border)" },
  rowBorder: { color: "var(--cg-border-subtle)" },
  // Row rhythm carries the structure; vertical rules as well would be a grid of
  // boxes rather than a table.
  columnBorder: false,

  headerBackgroundColor: "var(--cg-surface-2)",
  headerTextColor: "var(--cg-text-muted)",
  headerFontWeight: 600,
  headerVerticalPaddingScale: 0.7,

  oddRowBackgroundColor: "transparent",
  rowHoverColor: "var(--cg-hover)",
  selectedRowBackgroundColor: "var(--cg-accent-soft)",
  columnHoverColor: "transparent",

  inputBackgroundColor: "var(--cg-surface)",
  inputBorder: { color: "var(--cg-border)" },
  focusShadow: { spread: 2, color: "var(--cg-focus-ring)" },

  cellEditingBorder: { color: "var(--cg-accent)" },
  cellEditingShadow: "none",
  popupShadow: "var(--cg-shadow-2)",
  menuBackgroundColor: "var(--cg-surface)",
  menuBorder: { color: "var(--cg-border)" },
});
