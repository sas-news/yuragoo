// Browser room-auth API (Task 18): invite-only room creation, join,
// reconnect token rotation, session->ticket exchange and the WS upgrade.
// Secrets only ever travel in request BODIES — the invite arrives via the
// URL fragment client-side; the WS ticket is the single exception, carried
// in the upgrade query (single-use, 30s TTL, consumed inside the DO).
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { buildInviteUrl } from "@yuragoo/platform";
import { playerNameSchema } from "@yuragoo/protocol";
import type { ServerBindings } from "../config";
import { CONTROL_PLANE_NAME } from "../control/ControlPlane";
import { newInviteSecret, sha256B64 } from "./invites";
import { originAllowed } from "./origin";

const BODY_LIMIT_BYTES = 16 * 1024;
const ROOM_ID_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_FIELD_MAX = 128;
const encoder = new TextEncoder();

const ERROR_STATUS: Readonly<Record<string, ContentfulStatusCode>> = {
  "unknown-room": 404,
  "not-created": 404,
  "bad-invite": 403,
  "platform-mismatch": 403,
  "room-full": 403,
  "bad-session": 403,
  "bad-reconnect": 403,
  "bad-ticket": 401,
  "ticket-expired": 401,
  "already-created": 409,
  "room-closed": 410,
  "room-expired": 410,
};

const KNOWN_CODES =
  /unknown-room|not-created|bad-invite|platform-mismatch|room-full|bad-session|bad-reconnect|bad-ticket|ticket-expired|already-created|room-closed|room-expired/;

const fail = (c: Context, kind: string, status: ContentfulStatusCode): Response =>
  c.json({ error: kind }, status);

// DO-RPC errors carry their code in the message prefix (`code: detail`);
// anything unrecognized is an internal failure, never echoed raw.
const codeOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return KNOWN_CODES.exec(message)?.[0] ?? "internal";
};

const failOn = (c: Context, code: string): Response => fail(c, code, ERROR_STATUS[code] ?? 500);

type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; res: Response };

// Reads a JSON object body under a hard 16KiB cap — oversized payloads are
// rejected outright, never truncated.
const readBody = async (c: Context): Promise<BodyResult> => {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
    return { ok: false, res: fail(c, "too-large", 413) };
  }
  const raw = await c.req.text();
  if (encoder.encode(raw).length > BODY_LIMIT_BYTES) {
    return { ok: false, res: fail(c, "too-large", 413) };
  }
  if (raw.trim() === "") return { ok: true, body: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, res: fail(c, "invalid-request", 422) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, res: fail(c, "invalid-request", 422) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
};

const stringField = (body: Record<string, unknown>, key: string, maxLen: number): string | null => {
  const value = body[key];
  return typeof value === "string" && value.length > 0 && value.length <= maxLen ? value : null;
};

const roomStub = (bindings: ServerBindings, roomId: string) => {
  const ns = bindings.GAME_ROOM;
  if (ns === undefined || !ROOM_ID_PATTERN.test(roomId)) return null;
  return ns.get(ns.idFromString(roomId));
};

export const createAuthApp = (bindings: ServerBindings): Hono => {
  const app = new Hono();

  // Browser pages are same-origin in production; local dev serves them from
  // the vite/preview port, so the room API must answer CORS for the exact
  // origins originAllowed already accepts — nobody else gets a header.
  app.use(
    "/api/*",
    cors({
      origin: (origin) => (originAllowed(origin, bindings) ? origin : undefined),
    }),
  );

  const guardOrigin = (c: Context): Response | null =>
    originAllowed(c.req.header("origin") ?? null, bindings)
      ? null
      : fail(c, "forbidden-origin", 403);

  app.post("/api/rooms", async (c) => {
    const denied = guardOrigin(c);
    if (denied !== null) return denied;
    const ns = bindings.GAME_ROOM;
    if (ns === undefined) return fail(c, "config", 503);
    const parsed = await readBody(c);
    if (!parsed.ok) return parsed.res;
    const inviteSecret = newInviteSecret();
    const inviteSecretHash = await sha256B64(inviteSecret);
    const roomId = ns.newUniqueId().toString();
    try {
      await ns
        .get(ns.idFromString(roomId))
        .initRoom({ inviteSecretHash, platform: "browser", nowMs: Date.now() });
    } catch (e) {
      return failOn(c, codeOf(e));
    }
    // The one and only time the raw invite secret leaves the server.
    return c.json({ roomId, inviteSecret, inviteUrl: buildInviteUrl(roomId, inviteSecret) });
  });

  app.post("/api/rooms/:id/join", async (c) => {
    const denied = guardOrigin(c);
    if (denied !== null) return denied;
    const stub = roomStub(bindings, c.req.param("id"));
    if (stub === null) return fail(c, "unknown-room", 404);
    const parsed = await readBody(c);
    if (!parsed.ok) return parsed.res;
    const inviteSecret = stringField(parsed.body, "inviteSecret", TOKEN_FIELD_MAX);
    if (inviteSecret === null) return fail(c, "invalid-request", 422);
    let displayName: string | null = null;
    const rawName: unknown = parsed.body.displayName;
    if (rawName !== undefined) {
      const checked = playerNameSchema.safeParse(rawName);
      if (!checked.success) return fail(c, "invalid-request", 422);
      displayName = checked.data;
    }
    // Self-declared playerId/host flags in the body are never even read —
    // the DO assigns the seat server-side.
    const inviteSecretHash = await sha256B64(inviteSecret);
    try {
      const joined = await stub.joinRoom({
        inviteSecretHash,
        displayName,
        platform: "browser",
        nowMs: Date.now(),
      });
      return c.json({
        playerId: joined.playerId,
        sessionToken: joined.sessionToken,
        reconnectToken: joined.reconnectToken,
        lobbyWaiting: joined.lobbyWaiting,
      });
    } catch (e) {
      return failOn(c, codeOf(e));
    }
  });

  app.post("/api/rooms/:id/reconnect", async (c) => {
    const denied = guardOrigin(c);
    if (denied !== null) return denied;
    const stub = roomStub(bindings, c.req.param("id"));
    if (stub === null) return fail(c, "unknown-room", 404);
    const parsed = await readBody(c);
    if (!parsed.ok) return parsed.res;
    const reconnectToken = stringField(parsed.body, "reconnectToken", TOKEN_FIELD_MAX);
    if (reconnectToken === null) return fail(c, "invalid-request", 422);
    const reconnectTokenHash = await sha256B64(reconnectToken);
    try {
      const rotated = await stub.reconnect({ reconnectTokenHash });
      return c.json({
        playerId: rotated.playerId,
        sessionToken: rotated.sessionToken,
        reconnectToken: rotated.reconnectToken,
      });
    } catch (e) {
      return failOn(c, codeOf(e));
    }
  });

  app.post("/api/rooms/:id/ticket", async (c) => {
    const denied = guardOrigin(c);
    if (denied !== null) return denied;
    const stub = roomStub(bindings, c.req.param("id"));
    if (stub === null) return fail(c, "unknown-room", 404);
    const parsed = await readBody(c);
    if (!parsed.ok) return parsed.res;
    const sessionToken = stringField(parsed.body, "sessionToken", TOKEN_FIELD_MAX);
    if (sessionToken === null) return fail(c, "invalid-request", 422);
    const sessionTokenHash = await sha256B64(sessionToken);
    try {
      const issued = await stub.issueTicket({ sessionTokenHash, nowMs: Date.now() });
      return c.json({ ticket: issued.ticket, expiresInSec: issued.expiresInSec });
    } catch (e) {
      return failOn(c, codeOf(e));
    }
  });

  // Public anonymous aggregates (Task 21): numbers only — pending until
  // the published totals cover >= 20 completed games. Served by the
  // deployment-wide ControlPlane.
  app.get("/api/stats", async (c) => {
    const denied = guardOrigin(c);
    if (denied !== null) return denied;
    const ns = bindings.CONTROL_PLANE;
    if (ns === undefined) return fail(c, "config", 503);
    try {
      const stats = await ns
        .get(ns.idFromName(CONTROL_PLANE_NAME))
        .publicStats({ nowMs: Date.now() });
      return c.json(stats);
    } catch (e) {
      return failOn(c, codeOf(e));
    }
  });

  // The upgrade forwards the request untouched into the DO, which consumes
  // the ticket atomically and accepts the socket there.
  app.get("/api/rooms/:id/ws", async (c) => {
    const denied = guardOrigin(c);
    if (denied !== null) return denied;
    const stub = roomStub(bindings, c.req.param("id"));
    if (stub === null) return fail(c, "unknown-room", 404);
    if (c.req.header("upgrade") !== "websocket") return fail(c, "upgrade-required", 426);
    const ticket = c.req.query("ticket");
    if (ticket === undefined || ticket === "") return fail(c, "bad-ticket", 401);
    return stub.fetch(c.req.raw);
  });

  return app;
};
