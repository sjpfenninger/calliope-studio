import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

import { collectPackages, writeLicenseNotice } from "./scripts/licensePlugin";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Source copied into the tree rather than installed, so no module graph and no
 * `node_modules` entry can find it: `src/components/ui/` is shadcn-vue, added
 * by `pnpm dlx shadcn-vue add` and then hand-edited. It is MIT, and the notice
 * has to say so because the components ship in the bundle like anything else.
 */
const VENDORED = [
  {
    name: "shadcn-vue (src/components/ui/)",
    version: null,
    license: "MIT",
    homepage: "https://github.com/unovue/shadcn-vue",
    texts: [
      {
        file: "LICENSE",
        text: readFileSync(here("./licenses/shadcn-vue-LICENSE.txt"), "utf8"),
      },
    ],
  },
];

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    // Writes THIRD_PARTY_LICENSES.md beside LICENSE, where `license-files` in
    // pyproject.toml names it so that it reaches both the sdist and the
    // wheel's dist-info. See the plugin for why the module graph, and not
    // `pnpm licenses list`, decides what goes in it.
    writeLicenseNotice(here("."), here("../THIRD_PARTY_LICENSES.md"), VENDORED),
  ],
  resolve: {
    alias: {
      // shadcn-vue's generated components import through `@/`, so this has to
      // match the `paths` entry in tsconfig.json.
      "@": here("./src"),
    },
  },
  build: {
    // Build straight into the Python package so that a wheel serves the UI from
    // the same process as the API. See `pixi run web-build`.
    outDir: here("../src/calliope_studio/server/static"),
    emptyOutDir: true,
  },
  worker: {
    // A `?worker` import is bundled by its own Rollup build, and the main
    // config's plugins do not apply to it. Without this line the notice covers
    // 51 packages instead of 57: prettier, the two vscode-languageserver-*,
    // jsonc-parser, path-browserify and @vscode/l10n reach the browser only
    // through the YAML worker, and would ship with nothing to attribute them.
    plugins: () => [collectPackages()],
  },
  test: {
    // A DOM for every test rather than a per-file annotation: the stores under
    // test read `document` and `localStorage`, and a DOM test that runs in the
    // node environment by mistake fails with an unhelpful "cannot read
    // properties of undefined" rather than saying what is missing.
    //
    // happy-dom rather than jsdom: jsdom 29 does not expose `localStorage` as a
    // global under vitest, even with an http origin set.
    environment: "happy-dom",
    // Shims what the DOM implementation leaves missing; see the file.
    setupFiles: ["./src/test-setup.ts"],
    // Monaco and its workers cannot be resolved outside a browser, and that
    // stops a test *collecting* rather than failing an assertion; see the stub.
    // Both patterns have to match the whole id — a rollup alias with a regex
    // replaces only the part it matched, so an unanchored `/\?worker$/` would
    // graft the stub's path onto the end of the worker's.
    alias: [
      { find: /^monaco-editor$/, replacement: "/src/test-stubs/browserOnly.ts" },
      { find: /^.*\?worker$/, replacement: "/src/test-stubs/browserOnly.ts" },
    ],
    coverage: {
      provider: "v8",
      // `lcov` is what the Codecov upload in ci.yml reads; `text` is for the
      // person who ran it.
      reporter: ["text", "lcov"],
      // Everything the app ships, including the components no unit test
      // reaches. The browser checks in `scripts/` exercise a great many of them
      // and contribute nothing here, so this number reads low on purpose —
      // narrowing the denominator to the layers that are unit-tested by design
      // would be a flattering measurement of a different thing.
      include: ["src/**/*.{ts,vue}"],
      exclude: ["src/**/*.d.ts", "src/**/*.test.ts", "src/test-setup.ts", "src/test-stubs/**"],
    },
  },
  server: {
    port: 5173,
    proxy: {
      // `pixi run serve` runs the API here. Proxying keeps the frontend's API
      // base URL relative in development as well as in production, so there is
      // no VITE_API_BASE_URL to configure.
      "/api": "http://127.0.0.1:8000",
    },
  },
});
