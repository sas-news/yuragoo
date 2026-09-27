// Task 41: the Discord CDN avatar rides the join — resolved from the
// verified /users/@me payload (never client input), stored on the seat,
// refreshed on rejoin and emitted on the wire's player view. Same
// fixture as discord-auth.test.ts: the Discord API is stubbed, the
// Worker + DO run for real.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { ServerEnvelope } from "@yuragoo/protocol";
import {
  type DiscordFetch,
  injectDiscordApiDeps,
} from "../../apps/server/src/auth/discord-membership";
import { Sock } from "./ws-helpers";

const BASE = "https://auth.test";
const ORIGIN = "http://localhost:5173";

interface FxUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

const fixture = () => {
  const users = new Map<string, FxUser>();
  let n = 0;
  const issue = (user: FxUser): string => {
    n += 1;
    const token = `tok-${n}`;
    users.set(token, user);
    return token;
  };
  const api: DiscordFetch = async (input, init) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/users/@me")) {
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      const user = users.get(bearer.slice("Bearer ".length));
      return user === undefined
        ? Response.json({ message: "401: Unauthorized" }, { status: 401 })
        : Response.json(user);
    }
    return new Response("not-found", { status: 404 });
  };
  return { api, issue };
};

afterEach(() => injectDiscordApiDeps(null));

// Alice carries an animated avatar hash ("a_" → .gif); Bob has none.
const ALICE: FxUser = { id: "111", username: "alice_u", global_name: "Alice A", avatar: "a_ani" };
const BOB: FxUser = { id: "222", username: "bob_u", global_name: null, avatar: null };
const ALICE_AVATAR = "https://cdn.discordapp.com/avatars/111/a_ani.gif?size=64";

const join = async (instanceId: string, token: string) => {
  const res = await SELF.fetch(`${BASE}/api/rooms/discord/join`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ instanceId, accessToken: token }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { roomId: string; playerId: string; sessionToken: string };
};

const playerRows = (roomId: string) =>
  runInDurableObject(env.GAME_ROOM.get(env.GAME_ROOM.idFromString(roomId)), (_i, ctx) =>
    ctx.storage.sql.exec("SELECT * FROM room_players").toArray(),
  );

test("happy: join stores the CDN avatar and the snapshot carries avatarUrl", async () => {
  const fx = fixture();
  injectDiscordApiDeps({ fetch: fx.api });
  const j = await join("av-1", fx.issue(ALICE));
  const rows = await playerRows(j.roomId);
  expect(rows[0]?.avatar_url).toBe(ALICE_AVATAR);
  const sock = await Sock.connect(j.roomId, j.sessionToken);
  const snap = sock.log.find((e: ServerEnvelope) => e.type === "snapshot");
  if (snap === undefined || snap.type !== "snapshot") throw new Error("no snapshot");
  expect(snap.payload.players[0]?.avatarUrl).toBe(ALICE_AVATAR);
  sock.close();
});

test("happy: rejoin refreshes the stored avatar; avatar-less seats stay empty", async () => {
  const fx = fixture();
  injectDiscordApiDeps({ fetch: fx.api });
  const first = await join("av-2", fx.issue(ALICE));
  const again = await join("av-2", fx.issue({ ...ALICE, avatar: "static1" }));
  expect(again.playerId).toBe(first.playerId);
  const rows = await playerRows(first.roomId);
  expect(rows).toHaveLength(1);
  // static hash → .png
  expect(rows[0]?.avatar_url).toBe("https://cdn.discordapp.com/avatars/111/static1.png?size=64");
  const bob = await join("av-2", fx.issue(BOB));
  const rows2 = await playerRows(bob.roomId);
  expect(rows2.find((r) => r.player_id === bob.playerId)?.avatar_url).toBeNull();
});
