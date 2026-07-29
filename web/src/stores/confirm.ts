import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * One question, asked from anywhere, answered by a real dialog.
 *
 * This exists for `router.beforeEach`, which had the app's only
 * `window.confirm` — in a codebase whose design contract bans the native
 * `title` attribute for exactly the reason that an OS-drawn surface takes no
 * token, no radius and no delay. It was also the most consequential dialog
 * here: the thing standing between a user and losing unsaved model edits, and
 * the one that looked like it belonged to a different program.
 *
 * A store rather than a component the guard reaches into, because the guard
 * fires while *leaving* the shell — so the dialog cannot live inside the tree
 * that is being torn down. `App.vue` renders it above the router view.
 *
 * `beforeEach` may return a promise, which is what makes replacing a blocking
 * call possible at all: the navigation simply waits for `resolve`.
 */
export interface ConfirmRequest {
  title: string;
  message: string;
  /** The affirmative button's label — name the action, not "OK". */
  confirmLabel: string;
  /** Draws the affirmative button as destructive. */
  destructive?: boolean;
}

export const useConfirmStore = defineStore("confirm", () => {
  const request = ref<ConfirmRequest | null>(null);
  let settle: ((answer: boolean) => void) | null = null;

  function ask(next: ConfirmRequest): Promise<boolean> {
    // A second question while one is open would strand the first promise
    // forever, and a navigation guard awaiting it would hang the router.
    settle?.(false);
    request.value = next;
    return new Promise<boolean>((resolve) => {
      settle = resolve;
    });
  }

  function answer(value: boolean): void {
    request.value = null;
    settle?.(value);
    settle = null;
  }

  return { request, ask, answer };
});
