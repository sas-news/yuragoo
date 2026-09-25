// Server binding parsing. Secrets never appear in thrown messages or logs.
import type { WorkersAiRun } from "@yuragoo/ai";
import type { ControlPlane } from "./control/ControlPlane";
import type { GameRoom } from "./rooms/GameRoom";

export interface ServerBindings {
  APP_ENV?: string;
  JEV_API_KEY?: string;
  JEV_DAILY_ATTEMPT_CAP?: string;
  // Dev/test seam (Task 23): overrides the Jev upstream URL the room's
  // decision-job runner posts to, so e2e can point at a local fixture.
  // Production never sets this — the real endpoint is the default.
  JEV_UPSTREAM_URL?: string;
  // Normal-generation daily budget (the separate normal-LLM counter).
  GENERATION_DAILY_ATTEMPTS?: string;
  // Dev/test seam (Task 25): like JEV_UPSTREAM_URL, retargets the lobby's
  // one-shot choice generation at a local fixture. Local mode only —
  // production uses the Workers AI binding and never sets this.
  GENERATION_UPSTREAM_URL?: string;
  // Task 25: the Workers AI binding (production provider for the one-shot
  // normal-LLM calls). Absent in tests — providers are injected/mocked.
  AI?: WorkersAiRun;
  // Comma-separated Origin allowlist for the room-auth API. In local mode
  // every loopback origin (any port) is allowed on top of this list.
  ALLOWED_ORIGINS?: string;
  // Presence timing knobs (milliseconds, decimal strings). Production
  // defaults implement the contract — heartbeat 15s, lease 45s, empty-room
  // rejoin grace 60s. Tests and the wrangler e2e override them with
  // compressed values via `--var`; never read from client input.
  ROOM_HEARTBEAT_MS?: string;
  ROOM_LEASE_MS?: string;
  ROOM_EMPTY_GRACE_MS?: string;
  // Task 21 knobs: hysteresis between the expiry mark and the actual
  // delete (default 5s), and the room resource caps (contract defaults:
  // 8MiB content / 20 games / 12h) — tests compress them.
  ROOM_PURGE_DELAY_MS?: string;
  ROOM_MAX_CONTENT_BYTES?: string;
  ROOM_MAX_GAMES?: string;
  ROOM_MAX_LIFETIME_MS?: string;
  GAME_ROOM?: DurableObjectNamespace<GameRoom>;
  // Task 22: the single deployment-wide budget/registry DO.
  CONTROL_PLANE?: DurableObjectNamespace<ControlPlane>;
}

// Contract defaults (Task 20): heartbeat every 15s, presence lease 45s,
// empty-room rejoin grace 60s. Env vars compress them for tests.
// Task 21: a short hysteresis between the expiry mark and the actual
// delete — the mark itself already refuses every entrypoint.
export const HEARTBEAT_MS_DEFAULT = 15_000;
export const LEASE_MS_DEFAULT = 45_000;
export const EMPTY_GRACE_MS_DEFAULT = 60_000;
export const PURGE_DELAY_MS_DEFAULT = 5_000;

const positiveMs = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export interface PresenceTimings {
  readonly heartbeatMs: number;
  readonly leaseMs: number;
  readonly emptyGraceMs: number;
  readonly purgeDelayMs: number;
}

export const presenceTimings = (bindings: ServerBindings): PresenceTimings => ({
  heartbeatMs: positiveMs(bindings.ROOM_HEARTBEAT_MS, HEARTBEAT_MS_DEFAULT),
  leaseMs: positiveMs(bindings.ROOM_LEASE_MS, LEASE_MS_DEFAULT),
  emptyGraceMs: positiveMs(bindings.ROOM_EMPTY_GRACE_MS, EMPTY_GRACE_MS_DEFAULT),
  purgeDelayMs: positiveMs(bindings.ROOM_PURGE_DELAY_MS, PURGE_DELAY_MS_DEFAULT),
});

export type ServerMode = "local" | "production";

export const parseServerMode = (appEnv: string | undefined): ServerMode => {
  if (appEnv === undefined || appEnv === "" || appEnv === "production") return "production";
  if (appEnv === "local") return "local";
  throw new RangeError("APP_ENV must be 'local' or 'production'");
};

export interface GatewayConfig {
  readonly apiKey: string;
  readonly dailyAttemptCap: number;
}

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}

// Local-mode gateway config: the dev route refuses to send upstream unless a
// nonblank key and a positive integer daily cap are both present.
export const parseGatewayConfig = (bindings: ServerBindings): GatewayConfig => {
  const apiKey = bindings.JEV_API_KEY?.trim() ?? "";
  if (apiKey.length === 0) {
    throw new GatewayConfigError("JEV_API_KEY is required in local mode");
  }
  const cap = Number(bindings.JEV_DAILY_ATTEMPT_CAP);
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    throw new GatewayConfigError("JEV_DAILY_ATTEMPT_CAP must be a positive integer");
  }
  return { apiKey, dailyAttemptCap: cap };
};
