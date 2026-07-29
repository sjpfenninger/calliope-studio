import { describe, expect, it } from "vitest";

import {
  HISTORY_LIMIT,
  canGoBack,
  canGoForward,
  currentEntry,
  emptyHistory,
  forget,
  stepBack,
  stepForward,
  visit,
  type NavHistory,
} from "./navHistory";

/**
 * The back/forward stack, on its own.
 *
 * The store around it does the visible work — reopening a tab, replaying a
 * jump — but every way this feature can be *quietly* wrong is index arithmetic:
 * a forward tail that survives a new branch, a repeat click that stacks entries
 * so back needs pressing four times, a cap that drops an entry without moving
 * the cursor with it, and a `forget` that leaves the cursor naming a different
 * place than it did before. None of those throw, and all of them read as "the
 * back button is behaving oddly".
 */

const at = (tabId: string) => ({ tabId, anchor: null });

/** Visits in order, from empty. */
function walk(...ids: string[]): NavHistory {
  return ids.reduce((history, id) => visit(history, at(id)), emptyHistory());
}

describe("visit", () => {
  it("records the first landing and has nowhere to go from it", () => {
    const history = visit(emptyHistory(), at("file:a"));
    expect(history.entries).toHaveLength(1);
    expect(history.index).toBe(0);
    expect(canGoBack(history)).toBe(false);
    expect(canGoForward(history)).toBe(false);
  });

  it("ignores a landing on the place already current", () => {
    const history = walk("file:a", "file:b");
    // Clicking the tab that is already in front, which the tab bar does on
    // every click. Left in, the back button would need pressing once per click.
    expect(visit(history, at("file:b"))).toBe(history);
  });

  it("records a second jump into the same file at a different line", () => {
    const first = visit(emptyHistory(), {
      tabId: "file:a",
      anchor: { line: 12, column: 1 },
    });
    const second = visit(first, { tabId: "file:a", anchor: { line: 40, column: 1 } });
    expect(second.entries).toHaveLength(2);
    expect(currentEntry(second)?.anchor).toEqual({ line: 40, column: 1 });
  });

  it("distinguishes a bare tab from the same tab with a position", () => {
    const bare = visit(emptyHistory(), at("file:a"));
    const anchored = visit(bare, { tabId: "file:a", anchor: { line: 3, column: 1 } });
    expect(anchored.entries).toHaveLength(2);
  });

  it("discards what was ahead when you go somewhere new from behind", () => {
    const back = stepBack(stepBack(walk("file:a", "file:b", "file:c")));
    const branched = visit(back, at("file:d"));
    expect(branched.entries.map((entry) => entry.tabId)).toEqual(["file:a", "file:d"]);
    expect(canGoForward(branched)).toBe(false);
  });

  it("drops the oldest entry past the cap, and moves the cursor with it", () => {
    let history = emptyHistory();
    for (let n = 0; n <= HISTORY_LIMIT; n += 1) history = visit(history, at(`file:${n}`));

    expect(history.entries).toHaveLength(HISTORY_LIMIT);
    expect(history.entries[0].tabId).toBe("file:1");
    // The cursor must still name the entry just visited, not slide off it.
    expect(currentEntry(history)?.tabId).toBe(`file:${HISTORY_LIMIT}`);
    expect(history.index).toBe(HISTORY_LIMIT - 1);
  });
});

describe("stepping", () => {
  it("walks back and forward over the same entries", () => {
    const history = walk("file:a", "file:b", "file:c");
    const back = stepBack(stepBack(history));
    expect(currentEntry(back)?.tabId).toBe("file:a");
    expect(currentEntry(stepForward(back))?.tabId).toBe("file:b");
  });

  it("returns the same object at either end", () => {
    // Identity is the caller's "did anything change?", so it has to hold rather
    // than merely being equal — `back()` uses it to decide whether to replay.
    const history = walk("file:a", "file:b");
    expect(stepForward(history)).toBe(history);
    const start = stepBack(history);
    expect(stepBack(start)).toBe(start);
  });

  it("goes nowhere from an empty history", () => {
    const history = emptyHistory();
    expect(canGoBack(history)).toBe(false);
    expect(canGoForward(history)).toBe(false);
    expect(stepBack(history)).toBe(history);
    expect(stepForward(history)).toBe(history);
    expect(currentEntry(history)).toBeNull();
  });
});

describe("forget", () => {
  it("leaves a history with none of that tab alone", () => {
    const history = walk("file:a", "file:b");
    expect(forget(history, "run:gone")).toBe(history);
  });

  it("shifts the cursor down by the entries removed behind it", () => {
    const history = walk("run:x", "file:a", "run:x", "file:b");
    const kept = forget(history, "run:x");
    expect(kept.entries.map((entry) => entry.tabId)).toEqual(["file:a", "file:b"]);
    expect(currentEntry(kept)?.tabId).toBe("file:b");
  });

  it("leaves the cursor alone when the removals are all ahead of it", () => {
    const history = stepBack(stepBack(walk("file:a", "file:b", "run:x")));
    expect(currentEntry(history)?.tabId).toBe("file:a");
    const kept = forget(history, "run:x");
    expect(currentEntry(kept)?.tabId).toBe("file:a");
  });

  it("lands on the neighbour when the current entry is the one removed", () => {
    const history = walk("file:a", "run:x");
    const kept = forget(history, "run:x");
    expect(kept.entries.map((entry) => entry.tabId)).toEqual(["file:a"]);
    expect(currentEntry(kept)?.tabId).toBe("file:a");
    expect(canGoForward(kept)).toBe(false);
  });

  it("empties out when the tab was the whole history", () => {
    expect(forget(walk("run:x", "run:x"), "run:x")).toEqual(emptyHistory());
  });
});
