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
import { open, results } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";

const { check, failed, finish } = results();
const { browser, page } = await open();

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

/**
 * Lands somewhere the renderers actually are.
 *
 * The projects list has no chart, map, grid or editor on it, so checking the
 * theme there would pass while every canvas surface stayed broken. What is
 * available depends on what the server was opened on, which `/api/health` says.
 */
const health = await (await fetch(`${BASE}/api/health`)).json();
const workspaceMode = health.mode === "workspace" && health.workspace_id;

await page.goto(
  workspaceMode
    ? `${BASE}/projects/${health.workspace_id}/versions/${health.workspace_id}`
    : `${BASE}/results`,
  { waitUntil: "networkidle" },
);
await page.waitForTimeout(2500);

if (workspaceMode) {
  // Open a YAML file and a CSV, so Monaco and AG Grid both mount. Selected on
  // roles and test ids rather than on component class names: the previous
  // selectors named PrimeVue's internals and died with it.
  await page.getByRole("link", { name: "Files" }).click().catch(() => {});
  await page.locator('[data-testid="file-tree"]').waitFor().catch(() => {});
  await page.waitForTimeout(600);
  await page.getByText("model.yaml", { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(2000);

  // CSVs live in a folder, which has to be expanded before they can be clicked.
  const folder = page
    .locator('[data-testid="file-tree"] [role="treeitem"][aria-expanded="false"]')
    .first();
  if (await folder.count()) await folder.click().catch(() => {});
  await page.waitForTimeout(600);
  await page.getByText(/\.csv$/).first().click().catch(() => {});
}
await page.waitForTimeout(2500);

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
/**
 * A known, pre-existing fault: the monaco-yaml language worker answers no
 * requests, so YAML schema validation and completion are dead. Verified to
 * predate the Tailwind migration by rebuilding at the previous commit and
 * getting the same six errors, so it is reported rather than failed on — but it
 * is a real bug and CLAUDE.md's claim that schema completion works is wrong.
 */
const KNOWN_BROKEN = /Missing requestHandler/;
const knownErrors = consoleErrors.filter((message) => KNOWN_BROKEN.test(message));
const newErrors = consoleErrors.filter((message) => !KNOWN_BROKEN.test(message));

if (knownErrors.length) {
  console.log(
    `  note  ${knownErrors.length} monaco-yaml worker errors (known, pre-existing)`,
  );
}
check(`no unexpected console errors (${newErrors.length})`, newErrors.length === 0);
if (newErrors.length) console.log("console errors:", newErrors.slice(0, 5));

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

// ── The renderers that live outside the DOM ─────────────────────────────────
//
// Whichever of these the current page happens to show. They are checked here
// rather than in a unit test because none of them observes CSS: each has to be
// *told* the theme changed, and getting that wrong leaves one surface stuck on
// the old colours — which type-checking cannot see.

/** Actual pixel bytes, so two spellings of one colour compare equal. */
const asPixels = (value) =>
  page.evaluate((input) => {
    const raw = input.startsWith("--")
      ? getComputedStyle(document.documentElement).getPropertyValue(input).trim()
      : input;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = raw;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `${r},${g},${b}`;
  }, value);

const backgroundOf = async (selector) => {
  const raw = await page.evaluate((one) => {
    const element = document.querySelector(one);
    return element ? getComputedStyle(element).backgroundColor : null;
  }, selector);
  return raw ? asPixels(raw) : null;
};

const darkSurface = await asPixels("--cg-surface");

const monacoBackground = await backgroundOf(".monaco-editor .monaco-editor-background");
if (monacoBackground) {
  // Monaco was hardcoded to `vs-dark`, so it was a dark rectangle in a light app.
  check(`Monaco follows the theme (${monacoBackground})`, monacoBackground === darkSurface);
} else {
  console.log("  skip  Monaco is not on this page");
}

const gridBackground = await backgroundOf(".ag-root-wrapper");
if (gridBackground) {
  // AG Grid needs no JavaScript for this: its params are var(--cg-*).
  check(`AG Grid follows the theme (${gridBackground})`, gridBackground === darkSurface);
  check(
    "no legacy ag-theme class (AG Grid error #239)",
    (await page.locator(".ag-theme-quartz").count()) === 0,
  );
} else {
  console.log("  skip  AG Grid is not on this page");
}

if ((await page.locator(".maplibregl-map").count()) > 0) {
  check(
    "the map survives a theme change",
    (await page.locator(".maplibregl-canvas").count()) > 0,
  );
} else {
  console.log("  skip  the map is not on this page");
}

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

console.log(failed() ? `\n${failed()} check(s) failed` : "\nall token checks passed");
await finish(browser);
