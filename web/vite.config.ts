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
    outDir: fileURLToPath(new URL("../src/calligraph/server/static", import.meta.url)),
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
