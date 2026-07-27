/**
 * The YAML editor, and the language worker behind it.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   npm run monaco-check -- http://127.0.0.1:8791
 *
 * For most of this project's life that worker answered *nothing*. Every request
 * failed with `Missing requestHandler or method: doValidation / findLinks /
 * getCodeAction / findDocumentSymbols / getFoldingRanges`, so schema validation,
 * completion, symbols and folding were all dead — the entire reason monaco-yaml
 * is a dependency — and the only sign was six console errors nobody was reading.
 *
 * The cause was a version mismatch: monaco-editor 0.53 changed how a worker
 * hands over its foreign module, and monaco-yaml still speaks the older
 * protocol. `package.json` pins monaco-editor accordingly, and this is the check
 * that would notice if the pin were lifted.
 *
 * Validation is asserted through the markers Monaco puts in the DOM, because
 * that is the end of the chain: schema fetched, worker started, request
 * dispatched, answer rendered. If a squiggle appears for a key the schema
 * forbids and not for one it allows, everything in between is working.
 */
import { health, open, requireMode, results } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";

const { check, finish } = results();
const payload = requireMode(await health(BASE), "workspace", BASE);
const { browser, page, testId, consoleErrors } = await open();

console.log(`Monaco at ${BASE}`);
await page.goto(`${BASE}${payload.landing}`, { waitUntil: "networkidle" });
await page.getByRole("link", { name: "Files" }).click();
await testId("file-tree").waitFor({ timeout: 20000 });
await page.getByText("model.yaml", { exact: true }).first().click();
await page.waitForTimeout(4000);

check("the editor mounts", (await page.locator(".monaco-editor").count()) > 0);
check(
  "the file's content is shown",
  (await page.locator(".view-lines").first().textContent())?.includes("config") ?? false,
);

const workerErrors = consoleErrors.filter((line) =>
  line.includes("Missing requestHandler"),
);
check(
  `the language worker answers (${workerErrors.length} handler errors)`,
  workerErrors.length === 0,
  workerErrors[0],
);

// Nothing in `model.yaml` should be wrong, so a squiggle here means the schema
// and the file disagree — which is what a broken schema graft looks like.
const squiggles = () => page.locator(".squiggly-error, .squiggly-warning").count();
check("a valid model validates clean", (await squiggles()) === 0);

// And then something that genuinely is wrong. `techs` is a mapping of tech
// name to definition, so a string there is a type error the schema can see.
await page.locator(".view-lines").first().click();
await page.keyboard.press("Control+End");
await page.keyboard.type("\ntechs: not-a-mapping\n");
await page.waitForTimeout(4000);
check("a schema violation is marked", (await squiggles()) > 0);

await page.screenshot({ path: "/tmp/calliope-studio-monaco.png" });
console.log("screenshot: /tmp/calliope-studio-monaco.png");

// Undo, so the file is left as it was found. The editor never saved it, but a
// dirty tab would make the next check's "opening does not mark the tab dirty"
// assertion fail for reasons that have nothing to do with it.
await page.keyboard.press("Control+Z");
await page.keyboard.press("Control+Z");

await finish(browser);
