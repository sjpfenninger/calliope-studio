/**
 * What every browser check needs: a page, a way to assert, and an exit code.
 *
 * The checks are separate files because they need different servers — one wants
 * a model folder, one wants a solved `.nc` — and because a failure should say
 * which scenario broke rather than which line of a 300-line script. This is the
 * part they all shared.
 *
 * Uses the system Chromium rather than downloading one, so it needs
 * `playwright-core` only. Point CHROMIUM at a different binary if needed; CI
 * sets it to the one Playwright installs.
 *
 * **Nothing here sleeps for a guessed duration.** `waitForTimeout` was most of
 * the wall-clock cost of this suite — the results checks alone held 67 seconds
 * of it — and a fixed delay is wrong in both directions at once: too long on an
 * idle machine, too short on a loaded one, which is how a check that passes
 * locally fails in CI for no reason anyone can reproduce. `settle`, `stable` and
 * `quiet` below name what is actually being waited for, and the only one that
 * still counts milliseconds is `quiet`, which exists precisely for asserting
 * that *nothing* happens.
 */
import { chromium } from "playwright-core";

/**
 * Polls `condition` until it holds. Resolves false on timeout, never throws.
 *
 * A condition that *throws* counts as "not yet", which is the only useful
 * reading: half of what these poll for is an element that does not exist at the
 * first attempt, and every Playwright accessor on a missing element throws after
 * its own 30-second auto-wait. Letting that escape does not fail the check — it
 * takes the whole script down mid-run, so the checks after it never report at
 * all.
 */
export async function until(condition, { timeout = 20000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await condition()) return true;
    } catch {
      /* not yet */
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * A deliberate pause, and the only kind left in this suite.
 *
 * For asserting that something does *not* happen — no second request, no sneaked
 * download — where there is by definition no condition to wait for. Short,
 * because it bounds a race rather than waiting for work.
 */
export const quiet = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Counts matching requests, so a check can wait for the work a click sets off.
 *
 * This is what replaced the guessed delays. A click starts a request, the
 * request comes back, and only then is the thing under test up to date — all of
 * which is observable, where "2500ms ought to do it" is both slower than the
 * truth on an idle machine and wrong on a loaded one.
 *
 * `requestfailed` decrements as well as `requestfinished`. An aborted request is
 * *normal* here — `useResultFrame` cancels the in-flight one whenever the query
 * changes — and counting only successes would leave the tally stuck above zero,
 * after which every later wait runs to its timeout and the suite is slower than
 * the sleeps it replaced.
 */
export function trackRequests(page, match, describe = (request) => request.url()) {
  const seen = [];
  let inflight = 0;

  page.on("request", (request) => {
    if (!match(request)) return;
    inflight += 1;
    seen.push(describe(request));
  });
  const done = (request) => {
    if (match(request)) inflight -= 1;
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);

  /** Waits for everything already on the wire to come back. */
  const idle = (timeout) => until(() => inflight === 0, { timeout });

  /**
   * Runs an action and waits for the traffic it sets off to drain.
   *
   * Returns how many new requests went out, so a caller can assert on that
   * rather than on a length captured either side of a sleep. `expect: 0` skips
   * waiting for one to *start* — for an action that should change the page
   * without asking the server anything.
   *
   * The two waits have separate budgets on purpose. A request that is going to
   * be made starts within a few milliseconds of the click, so `grace` is short;
   * *finishing* can take as long as the server needs, so `timeout` is generous.
   * Sharing one budget is what made a click on an already-cached section — no
   * request at all, which is the correct behaviour — sit out the full timeout,
   * and eight of those made the editor checks slower than the sleeps they
   * replaced.
   */
  async function settle(action, { expect = 1, grace = 2000, timeout = 20000 } = {}) {
    const before = seen.length;
    await action?.();
    if (expect > 0) {
      await until(() => seen.length >= before + expect, { timeout: grace });
    }
    await idle(timeout);
    return seen.length - before;
  }

  return { seen, idle, settle, count: () => seen.length };
}

const EXECUTABLE =
  process.env.CHROMIUM ?? "/Applications/Chromium.app/Contents/MacOS/Chromium";

/**
 * Opens a page, and wires up the two things every check wants to know about:
 * console errors, and which frame requests went out.
 *
 * `deviceScaleFactor` defaults to 1 because every check here reads geometry in
 * CSS pixels and a check does not care how many device pixels are behind one.
 * `screenshots.mjs` is the exception and asks for 2: a README image is looked
 * at rather than measured, and at 1 the hairline borders this design language is
 * mostly made of come out as grey mush.
 *
 * @param {object} options
 * @param {{width: number, height: number}} [options.viewport]
 * @param {number} [options.deviceScaleFactor]
 */
export async function open({
  viewport = { width: 1400, height: 1000 },
  deviceScaleFactor = 1,
} = {}) {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
  const page = await browser.newPage({ viewport, deviceScaleFactor });

  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  const requests = trackRequests(
    page,
    (request) => request.url().includes("/frame/") && request.method() === "POST",
    (request) => {
      let query = null;
      try {
        query = JSON.parse(request.postData() ?? "{}");
      } catch {
        /* not our payload */
      }
      return { url: request.url(), query };
    },
  );

  const frames = requests.seen;
  const framesIdle = requests.idle;
  const settle = requests.settle;

  /**
   * Waits until `read` returns the same value several times running.
   *
   * What "the layout has settled" actually means. A splitter resizes over more
   * than one frame — reka emits on the next tick, and the results view applies a
   * layout twice, a frame apart, on purpose — so there is no single event to
   * wait for, but there is a value that stops changing. Typically settles in
   * ~150ms where the fixed sleep it replaces was 1500.
   */
  async function stable(read, { same = 3, interval = 50, timeout = 8000 } = {}) {
    const deadline = Date.now() + timeout;
    let last = JSON.stringify(await read());
    let runs = 1;
    while (runs < same) {
      if (Date.now() >= deadline) break;
      await quiet(interval);
      const next = JSON.stringify(await read());
      if (next === last) runs += 1;
      else {
        last = next;
        runs = 1;
      }
    }
    return JSON.parse(last);
  }

  /** Waits for MapLibre to have finished loading its style. */
  const mapReady = (timeout = 30000) =>
    page
      .waitForFunction(() => Boolean(window.__cgMap?.loaded?.()), undefined, {
        timeout,
        polling: 100,
      })
      .then(
        () => true,
        () => false,
      );

  return {
    browser,
    page,
    consoleErrors,
    frames,
    until,
    quiet,
    settle,
    framesIdle,
    stable,
    mapReady,
    /** `[data-testid="…"]`, which is the only kind of selector these use. */
    testId: (name) => page.locator(`[data-testid="${name}"]`),
  };
}

/**
 * Collects results so the process can exit non-zero on the first failure.
 *
 * `finish` prints a tally. That is not decoration: without it the only way to
 * know how many checks passed was to re-run the whole thing through `grep -c`,
 * and re-running a browser check to count its own output is minutes of wall
 * clock for information it already printed.
 */
export function results(label = "") {
  const failures = [];
  let passed = 0;
  let skipped = 0;
  return {
    check(description, condition, detail) {
      if (condition) {
        passed += 1;
        console.log(`  ok    ${description}`);
      } else {
        console.log(`  FAIL  ${description}${detail ? `\n        ${detail}` : ""}`);
        failures.push(description);
      }
    },
    skip(description) {
      skipped += 1;
      console.log(`  skip  ${description}`);
    },
    /** How many checks have failed so far. */
    failed: () => failures.length,
    async finish(browser, consoleErrors = []) {
      if (consoleErrors.length) {
        console.log("console errors:");
        consoleErrors.slice(0, 10).forEach((line) => console.log(`  ${line}`));
      }
      const tally = `${passed} passed, ${failures.length} failed, ${skipped} skipped`;
      console.log(`  ── ${label ? `${label}: ` : ""}${tally}`);
      await browser?.close();
      process.exit(failures.length ? 1 : 0);
    },
  };
}

/**
 * A request to the API, on a connection that is not reused.
 *
 * `connection: close` because a check that waits several seconds between calls —
 * for a subprocess to finish, say — outlives uvicorn's keep-alive timeout, and
 * Node's `fetch` then picks the closed socket back up and hangs until its
 * five-minute headers timeout. The failure looks like a hung server and is not one.
 */
export function api(url, init = {}) {
  // `CG_TRACE=1` prints each request. Worth keeping: the failure this guards
  // against looks like the *next* call hanging, so knowing which one is which is
  // the whole diagnosis.
  if (process.env.CG_TRACE) {
    console.log(`    -> ${init.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
  }
  return fetch(url, {
    ...init,
    headers: { connection: "close", ...(init.headers ?? {}) },
  });
}

/** The server's own account of what it was opened on. */
export async function health(base) {
  const response = await fetch(`${base}/api/health`);
  if (!response.ok) {
    console.error(`No server at ${base}.`);
    process.exit(2);
  }
  return response.json();
}

/** Refuses to run a check against the wrong kind of server, loudly. */
export function requireMode(payload, mode, base) {
  if (payload.mode !== mode) {
    console.error(
      `This check needs a server in "${mode}" mode; ${base} is in "${payload.mode}".`,
    );
    process.exit(2);
  }
  return payload;
}
