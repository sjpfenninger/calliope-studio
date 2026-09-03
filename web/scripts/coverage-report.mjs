/**
 * Turns the browser checks' coverage dumps into one lcov file.
 *
 * Each check records Chromium's V8 coverage of the served bundle (see
 * `recordCoverage` in harness.mjs) as ranges over the built chunks. This
 * remaps those ranges to `src/` through the source maps a coverage build
 * emits, with `ast-v8-to-istanbul` — the library vitest's own V8 provider
 * uses, so a `.vue` file's lines land where vitest would put them and
 * Codecov can union the two uploads per line. The `file://` URL handed to the
 * converter is load-bearing: it derives the filename from it and resolves the
 * map's relative `sources` against that directory, which is how
 * `../../../../web/src/App.vue` becomes an absolute path.
 *
 * The dumps are merged per chunk *before* conversion, with the same
 * `mergeProcessCovs` vitest uses. Twenty-odd checks each name the same two
 * dozen chunks, and converting is where the time goes — parsing an
 * unminified AppShell chunk and walking its AST — so converting each dump
 * separately made this a minute where merging first makes it seconds.
 *
 * Two things fail loudly on purpose. No dumps at all, and a run in which every
 * dump was skipped, both exit non-zero: an empty report uploads successfully
 * and reads exactly like the checks covering nothing, and the second case is
 * what a bundle built without `pnpm run build:coverage` looks like.
 *
 *   pnpm run coverage:browser [dump-dir] [static-dir]
 *
 * Defaults: `coverage/browser` (where the harness writes) and the package's
 * `server/static`. Writes `lcov.info` beside the dumps.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { mergeProcessCovs } from "@bcoe/v8-coverage";
import { convert } from "ast-v8-to-istanbul";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import { parseAstAsync } from "vite";

// A `.mts` import from a script: Node strips the annotations itself; see the file.
import { chunkPathFor, keepSource } from "./browserCoverage.mts";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [dumpArg, staticArg] = process.argv.slice(2);
const DUMPS = resolve(WEB, dumpArg ?? "coverage/browser");
const STATIC = resolve(WEB, staticArg ?? "../src/calliope_studio/server/static");

const dumpFiles = existsSync(DUMPS)
  ? readdirSync(DUMPS).filter((name) => name.endsWith(".json"))
  : [];
if (dumpFiles.length === 0) {
  console.error(`no coverage dumps in ${DUMPS}: were the checks run with WEB_COVERAGE_DIR set?`);
  process.exit(2);
}

// One ProcessCov per dump, keyed on the chunk's path on disk rather than the
// URL it was served from: the same chunk reaches the checks from two servers.
let scripts = 0;
let skipped = 0;
const processCovs = dumpFiles.map((name) => {
  const result = [];
  for (const entry of JSON.parse(readFileSync(join(DUMPS, name), "utf8"))) {
    const path = chunkPathFor(entry.url, STATIC);
    if (!path || !existsSync(path) || !existsSync(`${path}.map`)) {
      skipped += 1;
      continue;
    }
    scripts += 1;
    result.push({ scriptId: path, url: pathToFileURL(path).href, functions: entry.functions });
  }
  return { result };
});

if (scripts === 0) {
  console.error(
    `${skipped} scripts in ${dumpFiles.length} dumps and none had a chunk with a source map under ${STATIC}: was the bundle built with \`pnpm run build:coverage\`?`,
  );
  process.exit(2);
}

const coverageMap = libCoverage.createCoverageMap({});
const merged = mergeProcessCovs(processCovs);
for (const script of merged.result) {
  const path = fileURLToPath(script.url);
  const code = readFileSync(path, "utf8");
  const data = await convert({
    code,
    sourceMap: JSON.parse(readFileSync(`${path}.map`, "utf8")),
    ast: parseAstAsync(code),
    coverage: { functions: script.functions, url: script.url },
    wrapperLength: 0,
  });
  for (const [file, fileCoverage] of Object.entries(data)) {
    if (keepSource(file, WEB)) coverageMap.addFileCoverage(fileCoverage);
  }
}

const context = libReport.createContext({ dir: DUMPS, coverageMap });
reports.create("lcovonly", { projectRoot: WEB }).execute(context);
reports.create("text-summary").execute(context);
console.log(
  `${dumpFiles.length} dumps, ${scripts} scripts over ${merged.result.length} chunks, ${skipped} skipped (no chunk or map on disk) → ${join(DUMPS, "lcov.info")}`,
);
