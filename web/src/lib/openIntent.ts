import type { OpenOptions } from "@/stores/tabs";

/**
 * What a click on a file, a model entry or a run asked for.
 *
 * One rule, in one place, because it is applied by both explorer trees and the
 * run list and they must not drift: a plain click *previews* — it reuses one
 * tab, so browsing a model does not fill the bar — while Cmd-click (Ctrl
 * elsewhere) or a double-click opens a tab that stays.
 *
 * `metaKey || ctrlKey` is the same test the editors' Cmd-S handlers use. On
 * macOS a Ctrl-click raises a context menu rather than a click, so accepting
 * both is harmless there.
 *
 * The double-click case needs no `dblclick` listener: the second click of a
 * double-click carries `detail === 2`, and re-opening a tab non-previewed is
 * exactly what promotes it. `detail` is on `UIEvent`, so a keyboard selection
 * reads 0 and previews.
 *
 * Shift counts only from the keyboard. A Shift-click is a range-select gesture
 * everywhere else and must stay a preview, but there is no keyboard
 * double-click, and Cmd-Enter is bound by the browser on some platforms — so
 * Shift+Enter is the keyboard's second way to say "keep this one".
 */
export function openIntent(event: MouseEvent | KeyboardEvent): OpenOptions {
  const keyboard = event instanceof KeyboardEvent;
  const newTab =
    event.metaKey || event.ctrlKey || event.detail > 1 || (keyboard && event.shiftKey);
  return { preview: !newTab };
}
