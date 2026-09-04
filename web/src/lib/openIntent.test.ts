import { describe, expect, it } from "vitest";

import { openIntent } from "./openIntent";

/**
 * What a click asked for — the rule both explorer trees and the run list apply.
 *
 * It has to be one function because the two failures are opposite and both
 * quiet. Read as "keep" when the user meant "preview", browsing a model fills
 * the tab bar with rows nobody asked to keep; read as "preview" when they meant
 * "keep", the tab they just double-clicked or Cmd-clicked is silently replaced
 * by the next thing they look at, taking its place in the bar with it.
 *
 * Real events rather than object literals, because the whole mechanism rests on
 * two properties the DOM sets and we never do: `detail`, which is 2 on the
 * second click of a double-click and 0 on a keyboard activation, and the
 * modifier flags.
 */

const click = (init: MouseEventInit = {}) =>
  new MouseEvent("click", { detail: 1, ...init });

describe("openIntent", () => {
  it("previews on a plain click", () => {
    expect(openIntent(click())).toEqual({ preview: true });
  });

  it("opens a tab that stays on Cmd-click and on Ctrl-click", () => {
    // Both, not one per platform: on macOS a Ctrl-click raises a context menu
    // rather than a click, so accepting it costs nothing and a Linux or Windows
    // user gets the modifier their platform actually uses.
    expect(openIntent(click({ metaKey: true }))).toEqual({ preview: false });
    expect(openIntent(click({ ctrlKey: true }))).toEqual({ preview: false });
  });

  it("opens a tab that stays on the second click of a double-click", () => {
    // The reason there is no `dblclick` listener anywhere: the second click
    // carries `detail === 2`, and re-opening an already-previewed tab
    // non-previewed is exactly what promotes it.
    expect(openIntent(click({ detail: 2 }))).toEqual({ preview: false });
    // A third click is still not a preview — a triple-click must not demote the
    // tab the double-click just made permanent.
    expect(openIntent(click({ detail: 3 }))).toEqual({ preview: false });
  });

  it("previews on a keyboard activation", () => {
    // `detail` lives on `UIEvent`, so a key press reads 0 — and `0 > 1` is
    // false. Arrowing through a tree with Enter therefore browses, which is the
    // same thing clicking through it does.
    const keyboard = new KeyboardEvent("keydown", { key: "Enter" });
    expect(keyboard.detail).toBe(0);
    expect(openIntent(keyboard)).toEqual({ preview: true });
  });

  it("honours a modifier held during a keyboard activation", () => {
    // Cmd-Enter is the keyboard's Cmd-click, and the modifier test is shared
    // rather than being a mouse-only branch.
    expect(
      openIntent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true })),
    ).toEqual({ preview: false });
  });

  it("opens a tab that stays on Shift+Enter, from the keyboard only", () => {
    // The keyboard has no double-click, and Cmd-Enter is taken by the browser
    // on some platforms — so without this the only keyboard path through a
    // tree could preview and never keep. A Shift-*click* stays a preview: it
    // is the range-select gesture everywhere else, and the test below pins it.
    expect(
      openIntent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true })),
    ).toEqual({ preview: false });
  });

  it("ignores the modifiers that mean something else", () => {
    // Shift and Alt are range-select and platform gestures. Treating either as
    // "keep this tab" would make an ordinary selection sweep pin a row.
    expect(openIntent(click({ shiftKey: true }))).toEqual({ preview: true });
    expect(openIntent(click({ altKey: true }))).toEqual({ preview: true });
  });
});
