// Browser room-auth API (Task 18): invite-only room creation, join,
// reconnect token rotation, session->ticket exchange and the WS upgrade.
// Secrets only ever travel in request BODIES — the invite arrives via the
// URL fragment client-side; the WS ticket is the single exception, carried
// in the upgrade query (single-use, 30s TTL, consumed inside the DO).
// Error codes, the body reader and the origin guard live in ./registry so
// the Task 35 Discord routes share one contract.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { buildInviteUrl } from "@yuragoo/platform";
import { playerNameSchema } from "@yuragoo/protocol";
import type { ServerBindings } from "../config";
import { CONTROL_PLANE_NAME } from "../control/ControlPlane";
import { createDiscordRoutes } from "./discord-session";
import { newInviteSecret, sha256B64 } from "./invites";
import { originAllowed } from "./origin";
import {
  codeOf,
  fail,
  failOn,
  guardOrigin,
  readBody,
  roomStub,
  stringField,
  TOKEN_FIELD_MAX,
} from "./registry";

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

  const guard = guardOrigin(bindings);

  // Task 35 Discord surface — registered before /api/rooms/:id/* so the
  // static "discord" segment can never be read as a room-id parameter.
  app.route("/", createDiscordRoutes(bindings));

  app.post("/api/rooms", async (c) => {
    const denied = guard(c);
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
    const denied = guard(c);
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
    const denied = guard(c);
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
    const denied = guard(c);
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
    const denied = guard(c);
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
    const denied = guard(c);
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
