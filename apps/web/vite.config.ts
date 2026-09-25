import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The e2e preview proxies /api (HTTP + WS upgrade) to a wrangler dev
// worker so the page and the room API share one origin — mirroring the
// production topology where the worker serves the app. YURAGOO_WORKER_ORIGIN
// points the proxy elsewhere when needed; the default is the port the
// playwright webServer boots wrangler on.
export default defineConfig({
  plugins: [react()],
  preview: {
    proxy: {
      "/api": {
        target: process.env.YURAGOO_WORKER_ORIGIN ?? "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true,
      },
      // Task 23: a second worker origin used only by the restart test — a
      // disposable wrangler dev on :8899 with its own persist dir. The
      // name must NOT start with /api: the proxy matches contexts by
      // prefix and "/api" would swallow these requests first.
      "/r2-api": {
        target: "http://127.0.0.1:8899",
        changeOrigin: true,
        ws: true,
        // The bridge calls <origin>/api/... — stripping the prefix leaves
        // the real worker path behind.
        rewrite: (path: string) => path.replace(/^\/r2-api/, ""),
      },
    },
  },
});
