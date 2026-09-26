// Shared { error: code } plumbing for the room-auth API (browser routes
// and Task 35 Discord routes alike). DO-RPC errors carry "code: detail"
// messages; codeOf maps them onto KNOWN_CODES (anything else is
// "internal", never echoed raw), ERROR_STATUS picks the HTTP status.
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ServerBindings } from "../config";
import { originAllowed } from "./origin";

export const BODY_LIMIT_BYTES = 16 * 1024;
export const ROOM_ID_PATTERN = /^[0-9a-f]{64}$/;
export const TOKEN_FIELD_MAX = 128;
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
  // Task 35 Discord auth: a rejected credential is a 403, a Discord
  // outage is an upstream 502 (429 keeps its own code), and missing
  // OAuth bindings are a deployment fault.
  "discord-auth": 403,
  "discord-upstream": 502,
  "discord-rate-limit": 429,
  config: 503,
};

const KNOWN_CODES =
  /unknown-room|not-created|bad-invite|platform-mismatch|room-full|bad-session|bad-reconnect|bad-ticket|ticket-expired|already-created|room-closed|room-expired|discord-auth|discord-upstream|discord-rate-limit|config/;

export const fail = (c: Context, kind: string, status: ContentfulStatusCode): Response =>
  c.json({ error: kind }, status);

export const codeOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return KNOWN_CODES.exec(message)?.[0] ?? "internal";
};

export const failOn = (c: Context, code: string): Response =>
  fail(c, code, ERROR_STATUS[code] ?? 500);

export type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; res: Response };

// Reads a JSON object body under a hard 16KiB cap — oversized payloads are
// rejected outright, never truncated.
export const readBody = async (c: Context): Promise<BodyResult> => {
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

export const stringField = (
  body: Record<string, unknown>,
  key: string,
  maxLen: number,
): string | null => {
  const value = body[key];
  return typeof value === "string" && value.length > 0 && value.length <= maxLen ? value : null;
};

export const roomStub = (bindings: ServerBindings, roomId: string) => {
  const ns = bindings.GAME_ROOM;
  if (ns === undefined || !ROOM_ID_PATTERN.test(roomId)) return null;
  return ns.get(ns.idFromString(roomId));
};

// Origin guard shared by every room-auth route: no ambient credentials
// exist, so a missing Origin is fine while a present one must match the
// ALLOWED_ORIGINS / DISCORD_ORIGINS allowlists (see ./origin).
export const guardOrigin =
  (bindings: ServerBindings) =>
  (c: Context): Response | null =>
    originAllowed(c.req.header("origin") ?? null, bindings)
      ? null
      : fail(c, "forbidden-origin", 403);
