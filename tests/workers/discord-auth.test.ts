// Task 35 Discord auth through the real Worker (SELF.fetch) + GAME_ROOM —
// only the Discord API is stubbed via injectDiscordApiDeps (the fixture
// answers /oauth2/token and /users/@me).
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { createAuthApp } from "../../apps/server/src/auth/browser";
import {
  type DiscordFetch,
  injectDiscordApiDeps,
} from "../../apps/server/src/auth/discord-membership";
import { discordRoomName } from "../../apps/server/src/auth/discord-session";

const BASE = "https://auth.test";
const ORIGIN = "http://localhost:5173"; // allowed by the test binding

interface FxUser {
  id: string;
  username: string;
  global_name: string | null;
}

// Stubbed API: codes mint tokens once (spent codes die — OAuth replay
// semantics) and /users/@me is the identity oracle.
const fixture = () => {
  const users = new Map<string, FxUser>();
  const codes = new Map<string, string>();
  let n = 0;
  const issue = (user: FxUser): string => {
    n += 1;
    const token = `tok-${n}`;
    users.set(token, user);
    return token;
  };
  const grant = (code: string, user: FxUser): string => {
    const token = issue(user);
    codes.set(code, token);
    return token;
  };
  const api: DiscordFetch = async (input, init) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/oauth2/token")) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const token = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      return token === undefined
        ? Response.json({ error: "invalid_grant" }, { status: 400 })
        : Response.json({ access_token: token, token_type: "Bearer" });
    }
    if (url.pathname.endsWith("/users/@me")) {
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      const user = users.get(bearer.slice("Bearer ".length));
      return user === undefined
        ? Response.json({ message: "401: Unauthorized" }, { status: 401 })
        : Response.json(user);
    }
    return new Response("not-found", { status: 404 });
  };
  return { api, grant, issue };
};

const deadApi =
  (status: number): DiscordFetch =>
  async () =>
    new Response("upstream error", { status });

const post = (path: string, body: unknown, origin = ORIGIN): Promise<Response> =>
  SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });

type Joined = {
  roomId: string;
  playerId: string;
  sessionToken: string;
  lobbyWaiting: boolean;
  displayName: string | null;
};

const join = async (instanceId: string, token: string): Promise<Joined> => {
  const res = await post("/api/rooms/discord/join", { instanceId, accessToken: token });
  expect(res.status).toBe(200);
  return (await res.json()) as Joined;
};

const playerRows = (roomId: string) =>
  runInDurableObject(env.GAME_ROOM.get(env.GAME_ROOM.idFromString(roomId)), (_i, ctx) =>
    ctx.storage.sql.exec("SELECT * FROM room_players").toArray(),
  );

afterEach(() => injectDiscordApiDeps(null));

const ALICE: FxUser = { id: "111", username: "alice_u", global_name: "Alice A" };
const BOB: FxUser = { id: "222", username: "bob_u", global_name: null };

test("happy: code exchange returns { access_token } and mints once", async () => {
  const fx = fixture();
  injectDiscordApiDeps({ fetch: fx.api, clientId: "cid", clientSecret: "csec" });
  const token = fx.grant("code-1", ALICE);
  const res = await post("/api/discord/token", { code: "code-1" });
  expect(res.status).toBe(200);
  expect((await res.json()) as { access_token: string }).toEqual({ access_token: token });
});

test("happy: verified join maps instanceId to a deterministic room", async () => {
  const fx = fixture();
  injectDiscordApiDeps({ fetch: fx.api });
  const j = await join("inst-1", fx.issue(ALICE));
  expect(j.roomId).toBe(env.GAME_ROOM.idFromName(discordRoomName("inst-1")).toString());
  expect(j.playerId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(j.lobbyWaiting).toBe(false);
  expect(j.displayName).toBe("Alice A");
  const rows = await playerRows(j.roomId);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.platform).toBe("discord");
  expect(rows[0]?.discord_user_id).toBe("111");
});

test("happy: same instance shares a room, a different instance a different room", async () => {
  const fx = fixture();
  injectDiscordApiDeps({ fetch: fx.api });
  const a = await join("inst-2", fx.issue(ALICE));
  const b = await join("inst-2", fx.issue(BOB));
  expect(b.roomId).toBe(a.roomId);
  expect(b.playerId).not.toBe(a.playerId);
  expect(b.displayName).toBe("bob_u"); // username fallback, no global_name
  expect(await playerRows(a.roomId)).toHaveLength(2);
  const other = await join("inst-other", fx.issue(BOB));
  expect(other.roomId).not.toBe(a.roomId);
});

test("happy: rejoining reclaims the same seat and rotates tokens", async () => {
  const fx = fixture();
  injectDiscordApiDeps({ fetch: fx.api });
  const first = await join("inst-4", fx.issue(ALICE));
  // A fresh OAuth token for the SAME Discord user still claims seat one.
  const again = await join("inst-4", fx.issue(ALICE));
  expect(again.playerId).toBe(first.playerId);
  expect(again.sessionToken).not.toBe(first.sessionToken);
  const rows = await playerRows(first.roomId);
  expect(rows).toHaveLength(1);
  // The rotated-out session token is dead immediately.
  const stale = await post(`/api/rooms/${first.roomId}/ticket`, {
    sessionToken: first.sessionToken,
  });
  expect(stale.status).toBe(403);
  const fresh = await post(`/api/rooms/${first.roomId}/ticket`, {
    sessionToken: again.sessionToken,
  });
  expect(fresh.status).toBe(200);
});

test("happy: a second socket replaces the first for the same seat", async () => {
  const fx = fixture();
  injectDiscordApiDeps({ fetch: fx.api });
  const j = await join("inst-5", fx.issue(ALICE));
  const upgrade = async () => {
    const res = await post(`/api/rooms/${j.roomId}/ticket`, { sessionToken: j.sessionToken });
    expect(res.status).toBe(200);
    const { ticket } = (await res.json()) as { ticket: string };
    const up = await SELF.fetch(`${BASE}/api/rooms/${j.roomId}/ws?ticket=${ticket}`, {
      headers: { upgrade: "websocket", origin: ORIGIN },
    });
    expect(up.status).toBe(101);
    return up.webSocket;
  };
  const first = await upgrade();
  first?.accept();
  const closed = new Promise<number>((resolve) => {
    first?.addEventListener("close", (e) => resolve((e as CloseEvent).code));
  });
  const second = await upgrade();
  second?.accept();
  expect(await closed).toBe(1000); // replaced by the newer generation
  second?.close();
});

test("failure: forged tokens and replayed codes are rejected", async () => {
  const fx = fixture();
  injectDiscordApiDeps({ fetch: fx.api, clientId: "cid", clientSecret: "csec" });
  const bad = await post("/api/rooms/discord/join", {
    instanceId: "inst-6",
    accessToken: "forged",
  });
  expect(bad.status).toBe(403);
  expect(((await bad.json()) as { error: string }).error).toBe("discord-auth");
  fx.grant("code-2", ALICE);
  expect((await post("/api/discord/token", { code: "code-2" })).status).toBe(200);
  const replay = await post("/api/discord/token", { code: "code-2" });
  expect(replay.status).toBe(403);
  expect(((await replay.json()) as { error: string }).error).toBe("discord-auth");
});

test("failure: upstream 429 and 500 surface bounded error codes", async () => {
  injectDiscordApiDeps({ fetch: deadApi(429) });
  const limited = await post("/api/rooms/discord/join", { instanceId: "i", accessToken: "t" });
  expect(limited.status).toBe(429);
  expect(((await limited.json()) as { error: string }).error).toBe("discord-rate-limit");
  injectDiscordApiDeps({ fetch: deadApi(500), clientId: "cid", clientSecret: "csec" });
  const down = await post("/api/rooms/discord/join", { instanceId: "i", accessToken: "t" });
  expect(down.status).toBe(502);
  expect(((await down.json()) as { error: string }).error).toBe("discord-upstream");
  const downToken = await post("/api/discord/token", { code: "c" });
  expect(downToken.status).toBe(502);
});

test("failure: client-declared identity is ignored; browser joins are refused", async () => {
  const fx = fixture();
  injectDiscordApiDeps({ fetch: fx.api });
  const res = await post("/api/rooms/discord/join", {
    instanceId: "inst-7",
    accessToken: fx.issue(ALICE),
    displayName: "impostor",
    playerId: "claimed",
  });
  expect(res.status).toBe(200);
  const j = (await res.json()) as Joined;
  expect(j.displayName).toBe("Alice A");
  expect(j.playerId).not.toBe("claimed");
  expect((await playerRows(j.roomId))[0]?.display_name).toBe("Alice A");
  // The same room is unreachable through the browser invite path — even
  // guessing an invite secret dies at the platform gate first.
  const browser = await post(`/api/rooms/${j.roomId}/join`, { inviteSecret: "whatever" });
  expect(browser.status).toBe(403);
  expect(((await browser.json()) as { error: string }).error).toBe("platform-mismatch");
});

test("failure: the discord proxy origin needs the DISCORD_ORIGINS allowlist", async () => {
  const fx = fixture();
  injectDiscordApiDeps({ fetch: fx.api });
  const app = createAuthApp({
    APP_ENV: "local",
    GAME_ROOM: env.GAME_ROOM,
    DISCORD_ORIGINS: ".discordsays.com",
  });
  const call = (origin: string) =>
    app.fetch(
      new Request("http://localhost:8787/api/rooms/discord/join", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ instanceId: "inst-9", accessToken: fx.issue(BOB) }),
      }),
    );
  expect((await call("https://12345.discordsays.com")).status).toBe(200);
  expect((await call("https://evil.example")).status).toBe(403);
  expect((await call("http://12345.discordsays.com")).status).toBe(403);
});
