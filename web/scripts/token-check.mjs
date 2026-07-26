/**
 * Checks that the design tokens are actually live in a browser.
 *
 *   pixi run calligraph --no-browser --port 8791 example-model
 *   npm run token-check -- http://127.0.0.1:8791
 *
 * Every assertion here failed silently before Tailwind was adopted:
 * `assets/tokens.css` was never imported, so every `--cg-*` was undefined and
 * `charts/theme.ts` fell back to a hardcoded hex on every lookup; the vendored
 * IBM Plex woff2 files were referenced at a URL Vite never served, so the app
 * never loaded its own fonts; and nothing ever set `data-cg-theme`, so dark mode
 * was unreachable. None of that was visible to type-checking or to a unit test,
 * because all of it is about what the browser computes.
 *
 * It also records why `lib/cssColor.ts` has to exist: the *computed* value of an
 * oklch colour serialises back as `oklch(...)`, which zrender (ECharts),
 * MapLibre and Monaco all fail to parse. Printed below so the claim can be
 * re-checked when browsers change.
 */
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";
const EXECUTABLE =
  process.env.CHROMIUM ?? "/Applications/Chromium.app/Contents/MacOS/Chromium";

const failures = [];
function check(description, condition) {
  console.log(condition ? `  ok    ${description}` : `  FAIL  ${description}`);
  if (!condition) failures.push(description);
}

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

/** Reads the theme plumbing without the app running at all. */
async function withoutTheBundle({ colorScheme, stored }) {
  const context = await browser.newContext({ colorScheme, viewport: { width: 900, height: 600 } });
  const isolated = await context.newPage();
  if (stored) {
    await isolated.addInitScript(
      (value) => localStorage.setItem("calligraph.theme", value),
      stored,
    );
  }
  // Blocking every bundle chunk means whatever the theme is afterwards is the
  // inline head guard's work alone — the only way to show there is no flash.
  await isolated.route("**/assets/*.js", (route) => route.abort());
  await isolated.goto(BASE, { waitUntil: "domcontentloaded" });
  const seen = await isolated.evaluate(() => ({
    theme: document.documentElement.dataset.cgTheme ?? "unset",
    colorScheme: document.documentElement.style.colorScheme,
    appMounted: (document.getElementById("app")?.childElementCount ?? 0) > 0,
  }));
  await context.close();
  return seen;
}

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

await page.goto(BASE, { waitUntil: "networkidle" });

function readTokens() {
  return page.evaluate(async () => {
    // Forced rather than merely checked. A webfont is fetched lazily, only when
    // some text actually needs it, so `check()` alone reports "not loaded" for a
    // face nothing on this page happens to use — which says nothing about
    // whether its URL resolves. `load()` rejects on a 404, which is the failure
    // that went unnoticed for as long as the fonts were referenced at a path
    // Vite never served.
    const faces = ['16px "Inter"', '16px "IBM Plex Mono"'];
    await Promise.all(faces.map((face) => document.fonts.load(face)));

    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    // A throwaway element painted with the token, read back — the same trick
    // lib/cssColor.ts uses, so its assumptions get checked here too.
    const probe = document.createElement("span");
    probe.style.color = root.getPropertyValue("--cg-text").trim();
    document.body.append(probe);
    const computedColour = getComputedStyle(probe).color;
    probe.remove();
    return {
      accent: root.getPropertyValue("--cg-accent").trim(),
      bg: root.getPropertyValue("--cg-bg").trim(),
      shadcnBackground: root.getPropertyValue("--background").trim(),
      bodyFont: body.fontFamily,
      bodyFontSize: body.fontSize,
      bodyBackground: body.backgroundColor,
      interLoaded: document.fonts.check('16px "Inter"'),
      monoLoaded: document.fonts.check('16px "IBM Plex Mono"'),
      computedColour,
    };
  });
}

const light = await readTokens();
await page.evaluate(() => {
  document.documentElement.dataset.cgTheme = "dark";
});
const dark = await readTokens();

console.log("light --cg-bg:", light.bg, "| dark --cg-bg:", dark.bg);
console.log("a computed oklch colour serialises as:", light.computedColour);

check("tokens.css is loaded (--cg-accent resolves)", light.accent.startsWith("oklch"));
check(
  "shadcn aliases resolve through to a --cg token",
  light.shadcnBackground === light.bg,
);
check("Inter is loaded", light.interLoaded);
check("IBM Plex Mono is loaded", light.monoLoaded);
check("body uses Inter", light.bodyFont.includes("Inter"));
check("body is 13px", light.bodyFontSize === "13px");
check("data-cg-theme inverts the surface ramp", dark.bg !== light.bg);
check("the painted background follows it", dark.bodyBackground !== light.bodyBackground);
check("dark has its own accent", dark.accent !== light.accent);
check("no console errors", consoleErrors.length === 0);

if (consoleErrors.length) console.log("console errors:", consoleErrors.slice(0, 5));

// ── The toggle, which is the only way a user reaches any of this ─────────────

const toggle = page.locator('[data-testid="theme-toggle"]');
check("a theme toggle exists", (await toggle.count()) === 1);

const preference = () => page.evaluate(() => localStorage.getItem("calligraph.theme"));
const cycled = [];
for (let step = 0; step < 3; step += 1) {
  await toggle.click();
  cycled.push(await preference());
}
check(
  `the toggle cycles all three states (${cycled.join(" → ")})`,
  new Set(cycled).size === 3,
);

for (let step = 0; step < 4 && (await preference()) !== "dark"; step += 1) {
  await toggle.click();
}
const painted = await page.evaluate(
  () => getComputedStyle(document.body).backgroundColor,
);
check(
  `choosing dark repaints the body (${painted})`,
  (await preference()) === "dark" && painted !== light.bodyBackground,
);

// ── The pre-paint guard ─────────────────────────────────────────────────────

const guardSystemDark = await withoutTheBundle({ colorScheme: "dark" });
check(
  `the guard alone sets dark, with no app running (${JSON.stringify(guardSystemDark)})`,
  guardSystemDark.theme === "dark" &&
    guardSystemDark.colorScheme === "dark" &&
    !guardSystemDark.appMounted,
);
check(
  "the guard respects a light system",
  (await withoutTheBundle({ colorScheme: "light" })).theme === "light",
);
check(
  "a stored preference beats the system, both ways",
  (await withoutTheBundle({ colorScheme: "light", stored: "dark" })).theme === "dark" &&
    (await withoutTheBundle({ colorScheme: "dark", stored: "light" })).theme === "light",
);

await browser.close();

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall token checks passed");
