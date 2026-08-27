import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      // shadcn-vue's generated components import through `@/`, so this has to
      // match the `paths` entry in tsconfig.json.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // Build straight into the Python package so that a wheel serves the UI from
    // the same process as the API. See `pixi run web-build`.
    outDir: fileURLToPath(new URL("../src/calliope_studio/server/static", import.meta.url)),
    emptyOutDir: true,
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
