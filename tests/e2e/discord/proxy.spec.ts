// Task 36 proxy/spec gate: the production topology end-to-end on one
// worker — Workers Static Assets serve the SPA, /api/* runs the worker
// first, the WS upgrade lands on the same origin. A wrangler e2e env
// boots the assets-enabled config locally; apps/web/dist must exist
// (the spec builds it once when missing). No Discord traffic — the
// mapped proxy URL is simulated by serving everything from one origin.
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { type WorkerHandle, startWorker } from "../rooms/mp-fixture";

const DIST = join(process.cwd(), "apps", "web", "dist");
const PORT = 8898;
let worker: WorkerHandle;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  if (!existsSync(join(DIST, "index.html"))) {
    execSync("bun --cwd=apps/web run build", { stdio: "inherit" });
  }
  const dir = mkdtempSync(join(tmpdir(), "yuragoo-proxy-"));
  worker = await startWorker({
    port: PORT,
    dir,
    upstreamUrl: "http://127.0.0.1:8791/systemone",
    env: "e2e",
  });
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${worker.origin}/api/health`)).ok) break;
    } catch {}
    if (Date.now() > until) throw new Error("assets worker never came up");
    await new Promise((r) => setTimeout(r, 400));
  }
});
test.afterAll(async () => {
  await worker?.dispose();
});

test("happy: SPA, hashed assets, API and a real WS+join all ride one origin", async ({ page }) => {
  test.setTimeout(120_000);
  // The worker serves index.html — the SPA shell with hashed chunks.
  const res = await fetch(`${worker.origin}/`);
  expect(res.ok).toBe(true);
  const html = await res.text();
  expect(html).toContain('<div id="root">');
  const asset = /\/assets\/(index-[A-Za-z0-9_-]+\.[cm]?js)/.exec(html)?.[0];
  expect(asset).toBeTruthy();
  // The hashed chunk actually serves from the same origin.
  const chunk = await fetch(`${worker.origin}${asset}`);
  expect(chunk.ok).toBe(true);
  // Client route fallback: /r/<id> resolves to the SPA shell, not a 404.
  const room = await fetch(`${worker.origin}/r/${"b".repeat(64)}`);
  expect(room.ok).toBe(true);
  expect(await room.text()).toContain('<div id="root">');
  // Create -> join -> ticket -> ws all on the worker origin.
  const created = await fetch(`${worker.origin}/api/rooms`, { method: "POST", body: "{}" });
  expect(created.ok).toBe(true);
  const { roomId, inviteSecret } = (await created.json()) as {
    roomId: string;
    inviteSecret: string;
  };
  await page.goto(`${worker.origin}/r/${roomId}?hb=250&name=プロキシ#${inviteSecret}`);
  await page.waitForSelector("[data-player-id]", { timeout: 30_000 });
});

test("failure: API misses stay JSON 404 and foreign origins are refused", async () => {
  // run_worker_first hands /api to Hono — a miss is the API 404, never
  // the SPA shell (asset catch-all must not answer /api).
  const miss = await fetch(`${worker.origin}/api/never-a-route`);
  expect(miss.status).toBe(404);
  const missType = miss.headers.get("content-type") ?? "";
  expect(missType.includes("html")).toBe(false);
  // Origin guard still applies through the same-origin topology: a
  // foreign Origin gets 403 even though the page itself would load.
  const foreign = await fetch(`${worker.origin}/api/rooms`, {
    method: "POST",
    headers: { origin: "https://evil.example.com", "content-type": "application/json" },
    body: "{}",
  });
  expect(foreign.status).toBe(403);
});
