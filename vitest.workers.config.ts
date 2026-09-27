import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./apps/server/wrangler.jsonc" },
      // Test-only: the locally installed workerd binary tops out at this date.
      // Miniflare options take precedence over wrangler.jsonc, so production
      // keeps its planned 2026-09-19 compatibility date.
      miniflare: {
        compatibilityDate: "2026-08-22",
        // Test-only Origin allowlist for the Task 18 room-auth API;
        // production reads ALLOWED_ORIGINS from real deployment vars.
        bindings: {
          ALLOWED_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
          // .dev.vars may carry APP_ENV=local for wrangler dev; tests pin
          // production so the dev gateway and origin rules stay honest.
          APP_ENV: "production",
          // Task 20 presence timings compressed for tests (contract:
          // 15s heartbeat / 45s lease / 60s empty grace). Tests that need
          // determinism also backdate lease_until_ms directly via SQL.
          ROOM_HEARTBEAT_MS: "250",
          ROOM_LEASE_MS: "800",
          ROOM_EMPTY_GRACE_MS: "1500",
          // Task 22: server-side Jev credentials + daily caps. The key is a
          // fake test value — the upstream fetch is always stubbed. The cap
          // stays above the per-game 120 so per-game boundary tests fit;
          // the concurrency test fires reserves past it directly.
          JEV_API_KEY: "test-jev-key",
          JEV_DAILY_ATTEMPT_CAP: "200",
          GENERATION_DAILY_ATTEMPTS: "16",
        },
      },
    }),
  ],
  test: {
    include: ["tests/workers/**/*.test.ts"],
    // Default decision-job deps (fail-closed budget) so pre-Task-22 room
    // tests never touch the upstream API — see the file for the rationale.
    setupFiles: ["tests/workers/decision-deps-setup.ts"],
    // Presence adds per-message sweep commits and the presence tests do
    // real (compressed) clock waits — the 5s default was already marginal
    // under full-suite workerd parallelism.
    testTimeout: 15_000,
    // Errors thrown inside Durable Object RPC methods are correctly
    // re-thrown on the caller stub (tests assert .rejects), but workerd
    // also logs them as uncaught-in-promise inside the DO, which the pool
    // reports as unhandled errors. The pool marks every error that crossed
    // the DO boundary with `remote: true` — ignore ONLY those; genuine
    // unhandled errors in test code still fail the suite.
    onUnhandledError: (error) =>
      (error as { remote?: boolean }).remote === true ? false : undefined,
  },
});
