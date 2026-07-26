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
 */
import { chromium } from "playwright-core";

const EXECUTABLE =
  process.env.CHROMIUM ?? "/Applications/Chromium.app/Contents/MacOS/Chromium";

/**
 * Opens a page, and wires up the two things every check wants to know about:
 * console errors, and which frame requests went out.
 *
 * @param {object} options
 * @param {{width: number, height: number}} [options.viewport]
 */
export async function open({ viewport = { width: 1400, height: 1000 } } = {}) {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
  const page = await browser.newPage({ viewport });

  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  const frames = [];
  page.on("request", (request) => {
    if (request.url().includes("/frame/") && request.method() === "POST") {
      let query = null;
      try {
        query = JSON.parse(request.postData() ?? "{}");
      } catch {
        /* not our payload */
      }
      frames.push({ url: request.url(), query });
    }
  });

  return {
    browser,
    page,
    consoleErrors,
    frames,
    /** `[data-testid="…"]`, which is the only kind of selector these use. */
    testId: (name) => page.locator(`[data-testid="${name}"]`),
  };
}

/** Collects results so the process can exit non-zero on the first failure. */
export function results() {
  const failures = [];
  return {
    check(description, condition, detail) {
      if (condition) console.log(`  ok    ${description}`);
      else {
        console.log(`  FAIL  ${description}${detail ? `\n        ${detail}` : ""}`);
        failures.push(description);
      }
    },
    skip(description) {
      console.log(`  skip  ${description}`);
    },
    /** How many checks have failed so far. */
    failed: () => failures.length,
    async finish(browser, consoleErrors = []) {
      if (consoleErrors.length) {
        console.log("console errors:");
        consoleErrors.slice(0, 10).forEach((line) => console.log(`  ${line}`));
      }
      await browser.close();
      process.exit(failures.length ? 1 : 0);
    },
  };
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
