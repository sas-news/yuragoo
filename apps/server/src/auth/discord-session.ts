// Task 35 Discord room join: POST /api/rooms/discord/join binds an
// Activity instanceId to one deterministic GameRoom and seats the VERIFIED
// Discord user. The same Discord account always reclaims the same seat —
// commitJoin dedupes on the verified discord_user_id and rotates that
// seat's tokens, so the old session dies and a second socket replaces the
// first. The seat commit itself lives in ./sessions next to browser joins.
import { type Context, Hono } from "hono";
import type { ServerBindings } from "../config";
import { discordDisplayName, fetchDiscordUser, resolveDiscordDeps } from "./discord-membership";
import { discordTokenRoute } from "./discord-oauth";
import { newInviteSecret, sha256B64 } from "./invites";
import { codeOf, fail, failOn, guardOrigin, readBody, stringField } from "./registry";

export const DISCORD_PLATFORM = "discord";

// Discord snowflake-ish ids, bounded well under the 16KiB body cap.
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ACCESS_TOKEN_MAX = 512;

// The instanceId -> room mapping is stable forever: one Activity instance
// is one room. The "discord:" prefix keeps these named ids disjoint from
// the random hex ids browser rooms get from newUniqueId.
export const discordRoomName = (instanceId: string): string => `discord:${instanceId}`;

const discordJoinRoute = (bindings: ServerBindings) => async (c: Context) => {
  const denied = guardOrigin(bindings)(c);
  if (denied !== null) return denied;
  const ns = bindings.GAME_ROOM;
  if (ns === undefined) return fail(c, "config", 503);
  const parsed = await readBody(c);
  if (!parsed.ok) return parsed.res;
  const instanceId = stringField(parsed.body, "instanceId", 128);
  const accessToken = stringField(parsed.body, "accessToken", ACCESS_TOKEN_MAX);
  if (instanceId === null || accessToken === null || !INSTANCE_ID_PATTERN.test(instanceId)) {
    return fail(c, "invalid-request", 422);
  }
  try {
    // Identity is verified BEFORE the room exists — a forged or expired
    // token can never create rooms or seats.
    const user = await fetchDiscordUser(resolveDiscordDeps(bindings), accessToken);
    const nowMs = Date.now();
    const id = ns.idFromName(discordRoomName(instanceId));
    const stub = ns.get(id);
    // First use creates the room inside the join transaction itself —
    // the generated invite hash is stored but never shared, so the
    // browser invite path can never mint a seat inside a Discord room.
    const displayName = discordDisplayName(user);
    const joined = await stub.joinRoom({
      inviteSecretHash: await sha256B64(newInviteSecret()),
      discordUserId: user.id,
      displayName,
      platform: DISCORD_PLATFORM,
      nowMs,
    });
    return c.json({
      roomId: id.toString(),
      playerId: joined.playerId,
      sessionToken: joined.sessionToken,
      reconnectToken: joined.reconnectToken,
      lobbyWaiting: joined.lobbyWaiting,
      displayName: joined.displayName,
    });
  } catch (e) {
    return failOn(c, codeOf(e));
  }
};

// The Discord half of the auth API, mounted inside createAuthApp so it
// inherits the /api/* CORS middleware and the shared error registry.
export const createDiscordRoutes = (bindings: ServerBindings): Hono => {
  const app = new Hono();
  app.post("/api/discord/token", discordTokenRoute(bindings));
  app.post("/api/rooms/discord/join", discordJoinRoute(bindings));
  return app;
};
