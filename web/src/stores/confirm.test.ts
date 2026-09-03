import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { useConfirmStore, type ConfirmRequest } from "./confirm";

/**
 * The one question the router waits on.
 *
 * This replaced the app's only `window.confirm`, and it is the most consequential
 * dialog here: the thing standing between a user and losing unsaved model edits.
 * `router.beforeEach` may return a promise, which is what made replacing a
 * blocking call possible at all — and it is also what makes every failure below
 * a *hang* rather than a wrong answer. A promise that never settles, or one
 * settled twice with different answers, leaves the app on a route it has already
 * started leaving, with no dialog on screen and nothing to click.
 */
const question = (overrides: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  title: "Discard unsaved changes?",
  message: "Two files have edits that have not been saved.",
  confirmLabel: "Discard",
  ...overrides,
});

describe("useConfirmStore", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("holds the question until it is answered", () => {
    const store = useConfirmStore();
    expect(store.request).toBeNull();
    void store.ask(question());
    // Reactive, because `App.vue` renders the dialog off it — above the router
    // view, since the guard fires while the shell is being left and the dialog
    // cannot live in the tree that is going away.
    expect(store.request).toEqual(question());
  });

  it("resolves true when the affirmative button is pressed", async () => {
    const store = useConfirmStore();
    const answer = store.ask(question());
    store.answer(true);
    await expect(answer).resolves.toBe(true);
  });

  it("resolves false when the dialog is closed or cancelled", async () => {
    // Cancel, Escape and a click outside all arrive here. The negative answer
    // is the safe one: it aborts the navigation and leaves the edits alone.
    const store = useConfirmStore();
    const answer = store.ask(question());
    store.answer(false);
    await expect(answer).resolves.toBe(false);
  });

  it("clears the question as it answers, so the dialog closes", async () => {
    const store = useConfirmStore();
    const answer = store.ask(question());
    store.answer(true);
    expect(store.request).toBeNull();
    await answer;
  });

  it("resolves exactly once, whatever arrives afterwards", async () => {
    // A dialog can emit both a button press and a close: Reka fires
    // `update:open` on the way out. The second answer must not overwrite the
    // first — the guard would then have been told "go ahead" and "stop".
    const store = useConfirmStore();
    const settled: boolean[] = [];
    const answer = store.ask(question()).then((value) => settled.push(value));
    store.answer(true);
    store.answer(false);
    store.answer(false);
    await answer;
    expect(settled).toEqual([true]);
  });

  it("answers nothing at all when nothing was asked", () => {
    // A stray close event before any question — or after one already answered —
    // must not throw out of a component's event handler.
    const store = useConfirmStore();
    expect(() => store.answer(true)).not.toThrow();
    expect(store.request).toBeNull();
  });

  it("settles a question that a second one displaces, rather than stranding it", async () => {
    // The one case that would hang the router outright: two guards firing, or a
    // second navigation while the first dialog is up. The displaced promise is
    // resolved false — the conservative answer, which cancels the navigation
    // nobody is now looking at a dialog for.
    const store = useConfirmStore();
    const first = store.ask(question({ title: "First" }));
    const second = store.ask(question({ title: "Second" }));
    await expect(first).resolves.toBe(false);
    expect(store.request).toEqual(question({ title: "Second" }));

    // And the survivor is the one the button now answers.
    store.answer(true);
    await expect(second).resolves.toBe(true);
    expect(store.request).toBeNull();
  });
});
