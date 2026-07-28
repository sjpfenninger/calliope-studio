import * as monaco from "monaco-editor";

import { cssVarPx, resolvedHex } from "../lib/cssColor";

/**
 * A Monaco theme built from the CSS design tokens.
 *
 * Stock `vs`/`vs-dark` is not good enough here for two reasons. The editor was
 * hardcoded to `vs-dark`, so it has been a dark rectangle inside a light app —
 * the single most jarring thing in the UI. And Monaco is the largest surface in
 * the editor view, so `vs`'s near-white background and blue-grey gutter against
 * the app's own surface read as an embedded iframe rather than part of the page.
 *
 * **Monaco is hex-only.** Its colour parser accepts `#hex`, `rgb()` and `rgba()`
 * with a space after each comma, plus named keywords, and throws
 * `Invalid color format` on anything else — so these go through `resolvedHex`
 * rather than being passed as `var()`.
 *
 * Only the ~20 colours that carry the frame are set. Syntax token colours are
 * left to `inherit: true`: retinting YAML scalars by hand is a great deal of
 * fiddling for very little, and the stock token colours sit comfortably on these
 * surfaces.
 */
export const MONACO_THEME = "calliope-studio";

/**
 * Font size and line height, as numbers — Monaco measures text width in JS and
 * so cannot be handed a CSS variable.
 *
 * Functions rather than constants: a module-level read can run before the
 * stylesheet has landed, and would then bake in the fallback for the session.
 */
export const monacoFontSize = () => cssVarPx("--cg-font-size-sm", 12);
export const monacoLineHeight = () => cssVarPx("--cg-code-line-height", 18);

/** (Re)defines the theme from the current tokens, and applies it. */
export function applyMonacoTheme(mode: "light" | "dark"): void {
  const hex = resolvedHex;
  const transparent = "#00000000"; // design-check: allow colour

  monaco.editor.defineTheme(MONACO_THEME, {
    base: mode === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      // Comments are the one token worth aligning: YAML models are heavily
      // commented and the stock colour fights the muted text elsewhere.
      { token: "comment", foreground: hex("--cg-text-muted", "#6c6c6c").slice(1) },
    ],
    colors: {
      "editor.background": hex("--cg-surface", "#ffffff"),
      "editor.foreground": hex("--cg-text", "#1f1f1f"),
      "editorGutter.background": hex("--cg-surface", "#ffffff"),
      "editorLineNumber.foreground": hex("--cg-text-faint", "#8f8f8f"),
      "editorLineNumber.activeForeground": hex("--cg-text", "#1f1f1f"),
      "editor.lineHighlightBackground": hex("--cg-surface-2", "#f8f8f8"),
      // The default is a pair of rules above and below the line, which reads as
      // a selection rather than a cursor position.
      "editor.lineHighlightBorder": transparent,
      "editor.selectionBackground": hex("--cg-accent-soft-2", "#d6e6fe"),
      "editor.inactiveSelectionBackground": hex("--cg-active", "#e8e8e8"),
      "editorIndentGuide.background1": hex("--cg-border-subtle", "#e9e9e9"),
      "editorIndentGuide.activeBackground1": hex("--cg-border-strong", "#bebebe"),
      "editorCursor.foreground": hex("--cg-accent", "#026fff"),
      "editorWidget.background": hex("--cg-surface", "#ffffff"),
      "editorWidget.border": hex("--cg-border", "#dcdcdc"),
      "editorSuggestWidget.background": hex("--cg-surface", "#ffffff"),
      "editorSuggestWidget.selectedBackground": hex("--cg-accent-soft", "#ebf2fe"),
      "editorHoverWidget.background": hex("--cg-surface", "#ffffff"),
      "editorHoverWidget.border": hex("--cg-border", "#dcdcdc"),
      "editorError.foreground": hex("--cg-danger", "#d43031"),
      "editorWarning.foreground": hex("--cg-warning", "#ee9e10"),
      "editorOverviewRuler.border": transparent,
      "scrollbarSlider.background": `${hex("--cg-border-strong", "#bebebe")}66`,
      "scrollbarSlider.hoverBackground": `${hex("--cg-border-strong", "#bebebe")}99`,
      "scrollbarSlider.activeBackground": hex("--cg-border-strong", "#bebebe"),
      // The app draws its own focus ring; Monaco's would be a second one.
      focusBorder: transparent,
    },
  });

  // Global across every instance and model, so one call is enough — which
  // matters, because there is a single persistent editor `v-show`n across all
  // tabs and re-creating it would dispose every model, discarding unsaved
  // buffers. The theme must be *redefined* first, since its values just changed.
  monaco.editor.setTheme(MONACO_THEME);
}
