import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fresh local-persistence dir per run: wrangler dev otherwise reuses
// .wrangler/state, where the ControlPlane DO's per-UTC-day budgets
// (generation/JEV) and room registry leak across suite runs of the same
// day. A per-run store keeps every run hermetic and deterministic.
const persistDir = mkdtempSync(join(tmpdir(), "yuragoo-e2e-do-"));

export default defineConfig({
  testDir: "tests/e2e",
  forbidOnly: true,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  // Two servers: the wrangler dev worker (room API + GameRoom DO with
  // compressed Task 20 timings) and the vite preview that proxies /api to
  // it. Local mode keeps loopback origins allowed; the lease/grace values
  // are test-only compressions of the 45s/60s contract.
  webServer: [
    {
      command:
        "bunx wrangler dev apps/server/src/index.ts --port 8787 --ip 127.0.0.1 " +
        `--persist-to ${persistDir} ` +
        "--var APP_ENV:local --var ROOM_HEARTBEAT_MS:250 --var ROOM_LEASE_MS:800 " +
        "--var ROOM_EMPTY_GRACE_MS:1500 " +
        // Task 23: Jev calls must hit the spec's local fixture on :8791,
        // never the real provider. Plain-text key binding (local mode only).
        "--var JEV_API_KEY:e2e-test-key --var JEV_DAILY_ATTEMPT_CAP:500 " +
        "--var JEV_UPSTREAM_URL:http://127.0.0.1:8791/systemone " +
        // Task 25: the one-shot choice generation hits a local fixture on
        // :8792 (never real Workers AI). The daily counter lives in the
        // persisted ControlPlane DO — wrangler dev state survives across
        // runs of the same UTC day, so the e2e cap must cover a whole
        // session's repeated suite runs, not one run's ~5 attempts.
        "--var GENERATION_DAILY_ATTEMPTS:500 " +
        "--var GENERATION_UPSTREAM_URL:http://127.0.0.1:8792/choices " +
        "--compatibility-date 2026-08-22",
      url: "http://127.0.0.1:8787/api/health",
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: "bun --cwd=apps/web run build:e2e && bun --cwd=apps/web run preview:e2e",
      url: "http://127.0.0.1:4173",
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
