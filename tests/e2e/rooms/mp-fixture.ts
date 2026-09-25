// Task 23 e2e fixtures: the deterministic Jev upstream stand-in and the
// disposable workerd (Miniflare) used by the restart test.
//
// - startJevFixture: the worker's JEV_UPSTREAM_URL binding points every
//   decision call at this local server so e2e NEVER touches the real
//   provider. "hold" parks requests so a post stays pending across the
//   timeup boundary; "fail" answers 500; "ok" returns a contract-valid
//   distribution that always picks criteria[0].
// - startWorker: a real `wrangler dev` subprocess over its own persist dir
//   — the restart test kills it (whole tree, taskkill) and relaunches it
//   mid-match; the DOs rehydrate from the same SQLite storage.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

// The page talks to the disposable worker through the vite preview proxy:
// /r2-api/* -> http://127.0.0.1:8899/* (the proxy strips the prefix; the
// name must not begin with /api or the /api rule would match it first).
export const R2_PAGE_ORIGIN = "http://127.0.0.1:4173/r2-api";
export const R2_API_ORIGIN = "http://127.0.0.1:8899";
export const PRIMARY_API_ORIGIN = "http://127.0.0.1:8787";

export interface JevFixture {
  readonly url: string;
  readonly requests: number;
  mode: "ok" | "hold" | "fail";
  releaseHeld(): void;
  close(): Promise<void>;
}

export const startJevFixture = (port = 8791): Promise<JevFixture> => {
  const held: (() => void)[] = [];
  const state = { mode: "ok" as "ok" | "hold" | "fail", requests: 0 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      state.requests += 1;
      const answer = (status: number, body: string): void => {
        res.statusCode = status;
        res.end(body);
      };
      if (state.mode === "hold") {
        held.push(() => answer(500, "held-then-failed"));
        return;
      }
      if (state.mode === "fail") {
        answer(500, "fixture-failure");
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          questions?: { attraction?: { criteria?: Record<string, string> } };
        };
        const ids = Object.keys(parsed.questions?.attraction?.criteria ?? {});
        const probabilities: Record<string, number> = {};
        const rest = ids.length > 1 ? 0.3 / (ids.length - 1) : 0;
        for (const [i, id] of ids.entries()) probabilities[id] = i === 0 ? 0.7 : rest;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              attraction: {
                type: "choice",
                choice: ids[0] ?? "a",
                confidence: 0.5,
                probabilities,
              },
            },
            usage: { input_tokens: 12, output_tokens: 6 },
          }),
        );
      } catch {
        answer(400, "bad-fixture-request");
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${port}/systemone`,
        get requests() {
          return state.requests;
        },
        get mode() {
          return state.mode;
        },
        set mode(m: "ok" | "hold" | "fail") {
          state.mode = m;
        },
        releaseHeld: () => {
          for (const release of held.splice(0)) release();
        },
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
};

export interface WorkerHandle {
  readonly origin: string;
  dispose(): Promise<void>;
}

// Boot a disposable wrangler dev on `port`, persisting DO storage under
// <dir>/persist — a second call over the same dir is a real restart
// (fresh workerd process, same SQLite state). Same topology as the
// primary webServer: the repo-local wrangler binary + wrangler.jsonc.
export const startWorker = async (opts: {
  port: number;
  dir: string;
  upstreamUrl: string;
}): Promise<WorkerHandle> => {
  const bin = join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.exe" : "wrangler",
  );
  const child: ChildProcess = spawn(
    bin,
    [
      "dev",
      "apps/server/src/index.ts",
      "--port",
      String(opts.port),
      "--ip",
      "127.0.0.1",
      "--var",
      "APP_ENV:local",
      "--var",
      "ROOM_HEARTBEAT_MS:250",
      "--var",
      "ROOM_LEASE_MS:2000",
      "--var",
      "ROOM_EMPTY_GRACE_MS:30000",
      "--var",
      "JEV_API_KEY:e2e-test-key",
      "--var",
      "JEV_DAILY_ATTEMPT_CAP:500",
      "--var",
      `JEV_UPSTREAM_URL:${opts.upstreamUrl}`,
      "--compatibility-date",
      "2026-08-22",
      "--persist-to",
      join(opts.dir, "persist"),
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  // wrangler reports compile/binding problems on stderr — keep them for
  // postmortem instead of swallowing the only diagnostics we have.
  const stderrLog = join(opts.dir, "worker.stderr.log");
  child.stderr?.on("data", (chunk: Buffer) => appendFileSync(stderrLog, chunk));
  return {
    origin: `http://127.0.0.1:${opts.port}`,
    dispose: async () => {
      if (child.pid !== undefined && process.platform === "win32") {
        // wrangler spawns workerd as a child: kill the whole tree or the
        // port stays bound and the relaunched dev server cannot start.
        try {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
        } catch {
          // Already gone.
        }
      } else {
        child.kill("SIGTERM");
      }
      const until = Date.now() + 30_000;
      while (Date.now() < until) {
        try {
          // Any live listener on the port keeps this loop spinning.
          await fetch(`http://127.0.0.1:${opts.port}/api/health`, {
            signal: AbortSignal.timeout(500),
          });
        } catch {
          return; // connection refused — port released
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
  };
};

export const waitHealthy = async (origin: string, timeoutMs = 60_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${origin}/api/health`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > until) throw new Error(`worker at ${origin} never became healthy`);
    await new Promise((r) => setTimeout(r, 400));
  }
};

export interface AggregateTotals {
  readonly completedGames: number;
  readonly totalMessages: number;
  readonly totalDurationMs: number;
}

export const aggregateTotals = async (origin: string): Promise<AggregateTotals> =>
  (await (await fetch(`${origin}/api/dev/aggregates`)).json()) as AggregateTotals;

export const waitAggregate = async (
  origin: string,
  completedGames: number,
  timeoutMs = 15_000,
): Promise<AggregateTotals> => {
  const until = Date.now() + timeoutMs;
  let totals = await aggregateTotals(origin);
  while (totals.completedGames < completedGames && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
    totals = await aggregateTotals(origin);
  }
  return totals;
};
