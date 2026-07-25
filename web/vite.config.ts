import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  build: {
    // Build straight into the Python package so that a wheel serves the UI from
    // the same process as the API. See `pixi run web-build`.
    outDir: fileURLToPath(new URL("../src/calligraph/server/static", import.meta.url)),
    emptyOutDir: true,
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
