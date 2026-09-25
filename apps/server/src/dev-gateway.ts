// Worker app construction: production exposes only health; local mode adds
// the loopback-only dev JEV gateway backed by a shared attempt quota.
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  defaultSleep,
  InMemoryAttemptQuota,
  JevDecisionProvider,
  jevOutboundFetch,
  JevProviderError,
} from "@yuragoo/ai";
import { DecisionContractError, type DecisionState, parseDecisionState } from "@yuragoo/protocol";
import {
  type GatewayConfig,
  parseGatewayConfig,
  parseServerMode,
  type ServerBindings,
} from "./config";
import { CONTROL_PLANE_NAME } from "./control/ControlPlane";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;
const PROVIDER_TIMEOUT_MS = 3000;
const SESSION_ATTEMPT_CAP = 120;

export interface DevGatewayDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const ERROR_STATUS: Readonly<Record<string, ContentfulStatusCode>> = {
  quota: 429,
  "rate-limit": 429,
  auth: 502,
  upstream: 502,
  "invalid-request": 422,
  "invalid-response": 502,
  timeout: 504,
};

const fail = (c: Context, kind: string, status: ContentfulStatusCode): Response =>
  c.json({ error: kind }, status);

export const createProductionApp = (): Hono => {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true }));
  return app;
};

// The dev gateway answers browser calls from vite/preview on loopback only.
// Any origin that does not parse to a loopback host gets no allow-origin.
const loopbackOrigin = (origin: string): string | undefined => {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:") return undefined;
    return LOOPBACK_HOSTS.has(url.hostname) ? origin : undefined;
  } catch {
    return undefined;
  }
};

export const createLocalApp = (bindings: ServerBindings, deps: DevGatewayDeps = {}): Hono => {
  const app = createProductionApp();
  app.use("/api/dev/*", cors({ origin: loopbackOrigin }));
  let config: GatewayConfig | null = null;
  // One shared quota per local app so sequential and concurrent requests
  // consume the same daily and session counters.
  let quota: InMemoryAttemptQuota | null = null;
  const gateway = (): { config: GatewayConfig; quota: InMemoryAttemptQuota } => {
    if (config === null || quota === null) {
      config = parseGatewayConfig(bindings);
      quota = new InMemoryAttemptQuota({
        dailyAttemptCap: config.dailyAttemptCap,
        perSessionAttemptCap: SESSION_ATTEMPT_CAP,
      });
    }
    return { config, quota };
  };

  app.post("/api/dev/jev/evaluate", async (c) => {
    const host = new URL(c.req.url).hostname;
    if (!LOOPBACK_HOSTS.has(host)) return fail(c, "not-found", 404);
    let gw: { config: GatewayConfig; quota: InMemoryAttemptQuota };
    try {
      gw = gateway();
    } catch {
      return fail(c, "config", 503);
    }
    const body: unknown = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null) return fail(c, "invalid-request", 422);
    const sessionId: unknown = Reflect.get(body, "sessionId");
    const rawState: unknown = Reflect.get(body, "state");
    const validBody =
      Object.keys(body).length === 2 &&
      typeof sessionId === "string" &&
      SESSION_ID_PATTERN.test(sessionId) &&
      rawState !== undefined;
    if (!validBody) return fail(c, "invalid-request", 422);
    let state: DecisionState;
    try {
      state = parseDecisionState(rawState);
    } catch {
      return fail(c, "invalid-request", 422);
    }
    const nowMs = deps.nowMs ?? (() => Date.now());
    const provider = new JevDecisionProvider({
      apiKey: gw.config.apiKey,
      sessionId,
      quota: gw.quota,
      timeoutMs: PROVIDER_TIMEOUT_MS,
      fetch: deps.fetch ?? jevOutboundFetch,
      nowMs,
      sleep: deps.sleep ?? defaultSleep,
    });
    try {
      const result = await provider.evaluate(state, c.req.raw.signal);
      const snap = gw.quota.snapshot(sessionId, nowMs());
      return c.json({
        result,
        attempts: { dailyAttempts: snap.dailyAttempts, sessionAttempts: snap.sessionAttempts },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return new Response(JSON.stringify({ error: "abort" }), {
          status: 499,
          headers: { "content-type": "application/json" },
        });
      }
      if (error instanceof JevProviderError) {
        const status = ERROR_STATUS[error.kind];
        return c.json({ error: error.kind, retryable: error.retryable }, status ?? 502);
      }
      if (error instanceof DecisionContractError) return fail(c, "invalid-request", 422);
      return fail(c, "internal", 500);
    }
  });

  // Task 23 read-only seam: the all-time anonymous aggregate totals
  // (numbers only — completedGames/messages/duration) so e2e can prove a
  // finished game was counted exactly once. Local mode only; loopback host
  // only; never mounted in production.
  app.get("/api/dev/aggregates", async (c) => {
    const host = new URL(c.req.url).hostname;
    if (!LOOPBACK_HOSTS.has(host)) return fail(c, "not-found", 404);
    const ns = bindings.CONTROL_PLANE;
    if (ns === undefined) return fail(c, "config", 503);
    const totals = await ns.get(ns.idFromName(CONTROL_PLANE_NAME)).aggregateTotals();
    return c.json(totals);
  });
  return app;
};

export const createApp = (bindings: ServerBindings, deps: DevGatewayDeps = {}): Hono =>
  parseServerMode(bindings.APP_ENV) === "local"
    ? createLocalApp(bindings, deps)
    : createProductionApp();
