/**
 * Puts the cursor in the field a freshly added row exists to fill in.
 *
 * A new technology is a row called `(unnamed)` with one field that has to be
 * typed into before any of the others mean anything, so that is where focus
 * belongs. `TechsEditor` did this and eight other add buttons did not, including
 * the two whose new row is a blank key — the cursor stayed on the button and the
 * next keystroke went nowhere.
 *
 * `request` names the row by its `rowKey`; `bind` goes on the field's `:ref`
 * and fires exactly once, because it clears the request as it consumes it —
 * a `ref` callback runs on every re-render, and without that it would steal
 * focus back on each one. The focus itself waits a frame: Reka's collapsible
 * content is `hidden` for the frame it measures its height in, and a hidden
 * input silently refuses focus.
 *
 * A component may stand in for the input by exposing `focusName()`, so an
 * editor can bind to a child form (`NodeFields`, `LinkFields`) without reaching
 * into its markup.
 */
import { ref } from "vue";

interface FocusTarget {
  focusName: () => void;
}

function isFocusTarget(el: unknown): el is FocusTarget {
  return (
    typeof el === "object" &&
    el !== null &&
    typeof (el as FocusTarget).focusName === "function"
  );
}

/** Focuses `el` on the next frame, for the hidden-while-measuring case above. */
export function focusNextFrame(el: HTMLElement | null | undefined): void {
  if (!el) return;
  requestAnimationFrame(() => el.focus());
}

export function useFocusNew() {
  const pending = ref<string | null>(null);

  function request(key: string): void {
    pending.value = key;
  }

  function bind(el: unknown, key: string): void {
    if (pending.value !== key) return;
    if (el instanceof HTMLElement) {
      pending.value = null;
      focusNextFrame(el);
    } else if (isFocusTarget(el)) {
      pending.value = null;
      el.focusName();
    }
  }

  return { request, bind };
}
