/**
 * What the browser-coverage report counts, and what it must leave out.
 *
 * The report is generated, uploaded and read as a number, so the failures
 * worth guarding are the ones that produce a plausible file: a chunk URL that
 * silently resolves to nothing, and a source filter that admits `node_modules`
 * or a test file into the app's own percentage. `keepSource` has to agree with
 * the include/exclude in `vite.config.ts`, and this is the only place that
 * agreement is written down.
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { chunkPathFor, keepSource } from "./browserCoverage.mjs";

const STATIC = "/srv/static";
const WEB = "/repo/web";

describe("chunkPathFor", () => {
  it("maps a served chunk onto the file Vite emitted", () => {
    expect(chunkPathFor("http://127.0.0.1:8791/assets/AppShell-BML9r8x2.js", STATIC)).toBe(
      join(STATIC, "assets", "AppShell-BML9r8x2.js"),
    );
  });

  it("ignores the query and the host", () => {
    expect(chunkPathFor("http://localhost:8792/assets/index-abc.js?v=1", STATIC)).toBe(
      join(STATIC, "assets", "index-abc.js"),
    );
  });

  it("answers null for anything that is not a chunk on disk", () => {
    // An inline module has no file, a stylesheet has no coverage, and a
    // nested path is not somewhere Vite ever writes a script.
    expect(chunkPathFor("http://127.0.0.1:8791/", STATIC)).toBeNull();
    expect(chunkPathFor("http://127.0.0.1:8791/assets/AppShell.css", STATIC)).toBeNull();
    expect(chunkPathFor("http://127.0.0.1:8791/assets/x/y.js", STATIC)).toBeNull();
    expect(chunkPathFor("not a url", STATIC)).toBeNull();
  });

  it("refuses a path that would leave the assets directory", () => {
    expect(chunkPathFor("http://127.0.0.1:8791/assets/../index.html", STATIC)).toBeNull();
  });
});

describe("keepSource", () => {
  it("keeps the app's own TypeScript and components", () => {
    expect(keepSource(`${WEB}/src/App.vue`, WEB)).toBe(true);
    expect(keepSource(`${WEB}/src/lib/units.ts`, WEB)).toBe(true);
    expect(keepSource(`${WEB}/src/components/ui/button/index.ts`, WEB)).toBe(true);
  });

  it("drops everything vitest's coverage also drops", () => {
    expect(keepSource(`${WEB}/src/lib/units.test.ts`, WEB)).toBe(false);
    expect(keepSource(`${WEB}/src/env.d.ts`, WEB)).toBe(false);
    expect(keepSource(`${WEB}/src/test-setup.ts`, WEB)).toBe(false);
    expect(keepSource(`${WEB}/src/test-stubs/browserOnly.ts`, WEB)).toBe(false);
  });

  it("drops dependencies, styles and anything outside src/", () => {
    expect(keepSource(`${WEB}/node_modules/vue/dist/vue.runtime.esm-bundler.js`, WEB)).toBe(false);
    expect(keepSource(`${WEB}/src/style.css`, WEB)).toBe(false);
    expect(keepSource(`${WEB}/scripts/harness.mjs`, WEB)).toBe(false);
    expect(keepSource(`/elsewhere/src/App.vue`, WEB)).toBe(false);
  });
});
