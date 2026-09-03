/**
 * The pure half of `coverage-report.mjs`: which chunk on disk a script URL
 * names, and which remapped sources count.
 *
 * Both decisions fail silently when wrong. A URL that resolves to nothing
 * drops a chunk's coverage with no error to say so, and a filter one pattern
 * too wide puts `node_modules` lines into the app's number — in either case
 * the report is produced, uploaded and read as if it were right. That is why
 * they are here, tested, rather than inline in the script.
 *
 * A `.ts` file imported by a `.mjs` script: Node strips the annotations itself
 * (24 and 26, which pixi pins), and only annotations are used here, so nothing
 * has to be compiled first.
 */
import { join, relative, sep } from "node:path";

/**
 * `http://127.0.0.1:8791/assets/AppShell-abc.js` → `<static>/assets/AppShell-abc.js`.
 *
 * Only a chunk under `/assets/` is a candidate: that is where Vite emits every
 * script, and it is the one path the server mounts as static files. Anything
 * else — `index.html`'s inline module, a worker blob, an extension script —
 * has no file on disk to remap against and returns null.
 */
export function chunkPathFor(url: string, staticDir: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = /^\/assets\/([^/]+\.js)$/.exec(pathname);
  if (!match) return null;
  return join(staticDir, "assets", match[1]);
}

/**
 * The same set `vite.config.ts` gives vitest's coverage: everything under
 * `src/` that is `.ts` or `.vue`, minus declarations, tests and the test
 * scaffolding. Kept in step by hand; a file admitted here and not there would
 * show up on Codecov from one upload only.
 *
 * @param absPath a remapped source path, as the converter returns it
 * @param webDir the `web/` directory
 */
export function keepSource(absPath: string, webDir: string): boolean {
  const rel = relative(webDir, absPath).split(sep).join("/");
  if (!rel.startsWith("src/")) return false;
  if (!/\.(ts|vue)$/.test(rel)) return false;
  if (rel.endsWith(".d.ts") || rel.endsWith(".test.ts")) return false;
  if (rel === "src/test-setup.ts") return false;
  if (rel.startsWith("src/test-stubs/")) return false;
  return true;
}
