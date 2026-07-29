/**
 * Where you have been in the tab area, and how to get back there.
 *
 * One stack for the window rather than one per tab, because a jump lands
 * somewhere *else*: the provenance marker beside `techs:ccgt` opens
 * `templates.yaml`, and a per-tab history would have nothing in it at the
 * destination. So this is the browser's model — a linear list with a cursor —
 * and "back" means the previous place, whichever tab that was.
 *
 * A location is a **tab id** and, when the navigation named one, a position
 * inside it. The id is what makes going back work at all: `lib/tabId.ts` mints
 * ids that rebuild their tab, so an entry can *recreate* a tab rather than
 * merely re-select one. That is not a nicety. A plain click previews, the
 * preview slot holds one tab, and `settlePreview` closes the outgoing one — so
 * the very click that opened the template is what closed the tech behind it.
 * Back has to be able to bring it back.
 *
 * Kept pure and out of the store because the index arithmetic is where this
 * goes wrong: truncating the forward tail, coalescing a repeat visit, capping
 * the stack and — the fiddly one — dropping a dead run's entries while keeping
 * the cursor pointing at the same *place*.
 */

/** A position within a file, as `jumpTo` names one. */
export interface NavAnchor {
  line: number;
  column: number;
}

export interface NavEntry {
  /** The tab landed in. See `lib/tabId.ts`; this is enough to reopen it. */
  tabId: string;
  /** Where in it, or null when the navigation only named the tab. */
  anchor: NavAnchor | null;
}

export interface NavHistory {
  entries: NavEntry[];
  /** Which entry is current. `-1` when there are none. */
  index: number;
}

/**
 * How far back the stack remembers.
 *
 * Every entry is two small strings and a pair of numbers, so the cap is not
 * about memory — it is about the list staying a *recent* history rather than a
 * transcript of the session.
 */
export const HISTORY_LIMIT = 50;

export const emptyHistory = (): NavHistory => ({ entries: [], index: -1 });

export function currentEntry(history: NavHistory): NavEntry | null {
  return history.entries[history.index] ?? null;
}

export const canGoBack = (history: NavHistory): boolean => history.index > 0;

export const canGoForward = (history: NavHistory): boolean =>
  history.index >= 0 && history.index < history.entries.length - 1;

function sameLocation(a: NavEntry, b: NavEntry): boolean {
  if (a.tabId !== b.tabId) return false;
  if (a.anchor == null || b.anchor == null) return a.anchor === b.anchor;
  return a.anchor.line === b.anchor.line && a.anchor.column === b.anchor.column;
}

/**
 * Records a landing, and returns the history that results.
 *
 * Three rules, all of them the browser's:
 *
 * - Going somewhere while behind the front **discards what was ahead**. There is
 *   no tree here; a new branch replaces the old one.
 * - Landing where you already are records **nothing**. Clicking the tab that is
 *   already in front, or the same validation row twice, is not a step, and
 *   without this the back button would need pressing once per stray click.
 * - Past the cap the oldest entry goes, and the cursor moves down with it — so a
 *   long session cannot make `index` drift away from the entry it names.
 */
export function visit(history: NavHistory, entry: NavEntry): NavHistory {
  const here = currentEntry(history);
  if (here && sameLocation(here, entry)) return history;

  const entries = [...history.entries.slice(0, history.index + 1), entry];
  const overflow = Math.max(0, entries.length - HISTORY_LIMIT);
  return { entries: entries.slice(overflow), index: entries.length - overflow - 1 };
}

/**
 * Steps the cursor, returning the *same object* when there is nowhere to go.
 *
 * Identity rather than a boolean, so the caller's "did anything change?" is a
 * `===` and cannot disagree with `canGoBack`.
 */
export function stepBack(history: NavHistory): NavHistory {
  return canGoBack(history) ? { ...history, index: history.index - 1 } : history;
}

export function stepForward(history: NavHistory): NavHistory {
  return canGoForward(history) ? { ...history, index: history.index + 1 } : history;
}

/**
 * Drops every entry for a tab, keeping the cursor on the same place.
 *
 * For a tab that can never be reopened — a run the user has deleted — where
 * every other closed tab is reopenable from its id and so stays in the history.
 *
 * The cursor is the whole difficulty. Removals *behind* it shift it down by as
 * many; removals *ahead* leave it alone; and removing the current entry itself
 * leaves it pointing at whatever fell into that slot, clamped to the end. Doing
 * this by counting rather than by re-finding the current entry is what keeps it
 * correct when the current entry is one of the removed ones.
 */
export function forget(history: NavHistory, tabId: string): NavHistory {
  const entries = history.entries.filter((entry) => entry.tabId !== tabId);
  if (entries.length === history.entries.length) return history;
  if (!entries.length) return emptyHistory();

  const removedBefore = history.entries
    .slice(0, history.index)
    .filter((entry) => entry.tabId === tabId).length;
  const index = Math.min(history.index - removedBefore, entries.length - 1);
  return { entries, index: Math.max(0, index) };
}
