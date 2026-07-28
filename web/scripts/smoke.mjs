/**
 * Every results-view check, run at the same time against one server.
 *
 *   pixi run calliope-studio --no-browser --port 8792 path/to/results.nc
 *   pnpm run smoke http://127.0.0.1:8792
 *
 * This was one script of 850 lines and 77 checks covering the load, the filters,
 * the layouts, the map, the charts, the table, the exports and both themes. Two
 * things were wrong with that. A change to any one area cost a full run of all
 * of them, and the run was strictly sequential — one browser, one page, one
 * click at a time — when almost none of it depends on anything else.
 *
 * The parts only *read* the model, and each drives its own browser context with
 * its own `localStorage`, so nothing one does can reach another. They therefore
 * run concurrently, and the suite takes about as long as its slowest part rather
 * than the sum of all five.
 *
 * `--serial` runs them one after another, which is what you want when a failure
 * is hard to place: interleaved output from five browsers is not a transcript.
 * A part name runs just that part — `pnpm run smoke $BASE layout`.
 */
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { api, health } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The parts, slowest first.
 *
 * Order matters when the concurrency limit bites: starting the long pole first
 * is the difference between "as long as the slowest" and "as long as the slowest
 * plus whatever it queued behind".
 */
const PARTS = ["table", "layout", "map", "charts", "results"];

const args = process.argv.slice(2);
const serial = args.includes("--serial");
const jobsArg = args.find((arg) => arg.startsWith("--jobs="));
const rest = args.filter((arg) => arg !== "--serial" && !arg.startsWith("--jobs="));
const BASE = rest.find((arg) => /^https?:\/\//.test(arg)) ?? "http://127.0.0.1:8000";
const only = rest.filter((arg) => PARTS.includes(arg));
const parts = only.length ? only : PARTS;

const unknown = rest.filter((arg) => arg !== BASE && !PARTS.includes(arg));
if (unknown.length) {
  console.error(`Unknown part(s): ${unknown.join(", ")}. Known: ${PARTS.join(", ")}`);
  process.exit(2);
}

/**
 * How many parts run at once. Two, and that is a measurement rather than a
 * guess — so please re-measure before raising it.
 *
 * On a ten-core machine against `urban_scale_07.dev7.nc`, two runs of each:
 *
 *     jobs=1   26s
 *     jobs=2   15s      ← and 14/15/15 on three more runs
 *     jobs=3   24s      unstable: 12s once, 37s the next
 *     jobs=5   38s
 *
 * More than two is *slower* than serial, and the reason is that the parts do not
 * contend for the browser — they contend for the server. Uvicorn runs one
 * process, and every `/frame/` request does xarray work behind the GIL, so past
 * the point where one part can render while another waits on the wire, extra
 * browsers only queue against each other while competing for the same cores.
 *
 * The core count is a floor, not the target: a two-core CI runner ends up
 * serial, which is the right answer there.
 */
const DEFAULT_JOBS = 2;
const jobs = serial
  ? 1
  : Math.max(
      1,
      Math.min(
        parts.length,
        Number(jobsArg?.split("=")[1]) ||
          Math.min(DEFAULT_JOBS, Math.max(1, Math.floor(cpus().length / 2))),
      ),
    );

// Once, here, rather than five times in parallel — a server that is not up
// should say so before five browsers launch against it.
const server = await health(BASE);

/**
 * Puts the model in the server's cache before anything races for it.
 *
 * A solved model is roughly 17× its file size in memory and the server holds it
 * in a byte-budgeted LRU, so the first request after a start pays to load it —
 * and five browsers arriving at a cold cache at once turned a 26-second run into
 * a 226-second one. One sequential request first is the whole fix; every part
 * then finds it warm.
 */
if (server.results_handle) {
  await api(`${BASE}/api/results/${server.results_handle}/catalog/`).catch(() => {});
}

console.log(
  `Results view at ${BASE} — ${parts.length} parts, ${jobs} at a time`,
);

/** Runs one part, buffering its output so concurrent parts stay readable. */
function runPart(part) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(HERE, `smoke-${part}.mjs`), BASE],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ part, code, output }));
  });
}

/** Runs the queue `jobs` at a time, keeping the results in the parts' order. */
async function runAll() {
  const queue = [...parts];
  const outcomes = new Map();
  const worker = async () => {
    for (let part = queue.shift(); part; part = queue.shift()) {
      outcomes.set(part, await runPart(part));
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  return parts.map((part) => outcomes.get(part));
}

const started = Date.now();
const outcomes = await runAll();

let passed = 0;
let failed = 0;
let skipped = 0;

for (const { part, code, output } of outcomes) {
  console.log(`\n── ${part} ──`);
  process.stdout.write(output.replace(/^  ── .*\n?/gm, ""));
  passed += (output.match(/^ {2}ok {4}/gm) ?? []).length;
  failed += (output.match(/^ {2}FAIL {2}/gm) ?? []).length;
  skipped += (output.match(/^ {2}skip {2}/gm) ?? []).length;
  // A part that dies without printing a FAIL — a thrown selector, a crashed
  // browser — must not be counted as a clean run just because it wrote no
  // failing line.
  if (code !== 0 && !(output.match(/^ {2}FAIL {2}/gm) ?? []).length) {
    console.log(`  FAIL  ${part} exited ${code} without reporting`);
    failed += 1;
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n${passed} passed, ${failed} failed, ${skipped} skipped in ${seconds}s` +
    `${serial ? "" : ` across ${parts.length} parts`}`,
);
process.exit(failed ? 1 : 0);
