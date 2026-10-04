// Browser room-auth tests through the real Worker (SELF.fetch) and the
// GAME_ROOM binding. Storage-level assertions read the DO's SQLite via
// runInDurableObject.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import { createAuthApp } from "../../apps/server/src/auth/browser";
import { sha256B64 } from "../../apps/server/src/auth/invites";
import { TURN_SETTINGS } from "./room-helpers";

const BASE = "https://auth.test";
const GOOD_ORIGIN = "http://localhost:5173"; // in the test ALLOWED_ORIGINS binding
const EVIL_ORIGIN = "https://evil.example";

const post = (path: string, body: unknown, origin: string = GOOD_ORIGIN): Promise<Response> =>
  SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });

const upgrade = (path: string, origin: string = GOOD_ORIGIN): Promise<Response> =>
  SELF.fetch(`${BASE}${path}`, { headers: { upgrade: "websocket", origin } });

interface Created {
  roomId: string;
  inviteSecret: string;
  inviteUrl: string;
}
interface Joined {
  playerId: string;
  sessionToken: string;
  reconnectToken: string;
  lobbyWaiting: boolean;
}
interface Ticket {
  ticket: string;
  expiresInSec: number;
}

const createRoom = async (): Promise<Created> => {
  const res = await post("/api/rooms", {});
  expect(res.status).toBe(200);
  return (await res.json()) as Created;
};

const joinOk = async (room: Created, extra: Record<string, unknown> = {}): Promise<Joined> => {
  const res = await post(`/api/rooms/${room.roomId}/join`, {
    inviteSecret: room.inviteSecret,
    ...extra,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Joined;
};

const ticketOk = async (roomId: string, sessionToken: string): Promise<Ticket> => {
  const res = await post(`/api/rooms/${roomId}/ticket`, { sessionToken });
  expect(res.status).toBe(200);
  return (await res.json()) as Ticket;
};

const stubFor = (roomId: string) => env.GAME_ROOM.get(env.GAME_ROOM.idFromString(roomId));

test("happy: invite->join->ticket->upgrade 101->reconnect rotates both tokens", async () => {
  const room = await createRoom();
  // The invite URL carries the secret in the fragment only — never a query.
  expect(room.inviteUrl).toBe(`/r/${room.roomId}#${room.inviteSecret}`);
  expect(room.inviteUrl).not.toContain("?");

  const p = await joinOk(room, { displayName: "なまえ" });
  expect(p.playerId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(p.lobbyWaiting).toBe(false);

  const t = await ticketOk(room.roomId, p.sessionToken);
  expect(t.expiresInSec).toBe(30);

  const up = await upgrade(`/api/rooms/${room.roomId}/ws?ticket=${t.ticket}`);
  expect(up.status).toBe(101);
  expect(up.webSocket).not.toBeNull();
  up.webSocket?.accept();

  // Rotate while connected — a lobby close vacates the member outright,
  // so post-close re-entry is a fresh join, not token rotation.
  const re = await post(`/api/rooms/${room.roomId}/reconnect`, {
    reconnectToken: p.reconnectToken,
  });
  expect(re.status).toBe(200);
  const rotated = (await re.json()) as Joined;
  expect(rotated.playerId).toBe(p.playerId);
  expect(rotated.reconnectToken).not.toBe(p.reconnectToken);
  expect(rotated.sessionToken).not.toBe(p.sessionToken);
  // Both old tokens die immediately after rotation.
  expect(
    (await post(`/api/rooms/${room.roomId}/reconnect`, { reconnectToken: p.reconnectToken }))
      .status,
  ).toBe(403);
  expect(
    (await post(`/api/rooms/${room.roomId}/ticket`, { sessionToken: p.sessionToken })).status,
  ).toBe(403);
  up.webSocket?.close();
});

test("happy: six players join and the seventh is refused", async () => {
  const room = await createRoom();
  const ids = new Set<string>();
  for (let i = 0; i < 6; i += 1) {
    ids.add((await joinOk(room)).playerId);
  }
  expect(ids.size).toBe(6);
  const seventh = await post(`/api/rooms/${room.roomId}/join`, {
    inviteSecret: room.inviteSecret,
  });
  expect(seventh.status).toBe(403);
});

test("happy: midgame join lands as lobby-waiting", async () => {
  const room = await createRoom();
  const p1 = await joinOk(room);
  const p2 = await joinOk(room);
  // The game starts via the DO's game-create path (Task 17 RPC surface).
  await stubFor(room.roomId).createRoom({
    settings: TURN_SETTINGS,
    playerIds: [p1.playerId, p2.playerId],
    nowMs: Date.now(),
  });
  const late = await joinOk(room);
  expect(late.lobbyWaiting).toBe(true);
});

test("happy: local mode allows any loopback origin", async () => {
  const app = createAuthApp({ APP_ENV: "local", GAME_ROOM: env.GAME_ROOM });
  const local = (path: string, body: unknown, origin: string): Promise<Response> =>
    Promise.resolve(
      app.fetch(
        new Request(`http://localhost:8787${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify(body),
        }),
      ),
    );
  const res = await local("/api/rooms", {}, "http://127.0.0.1:6543");
  expect(res.status).toBe(200);
  const room = (await res.json()) as Created;
  const joined = await local(
    `/api/rooms/${room.roomId}/join`,
    { inviteSecret: room.inviteSecret },
    "http://localhost:9",
  );
  expect(joined.status).toBe(200);
});

test("failure: a wrong invite secret is refused", async () => {
  const room = await createRoom();
  const res = await post(`/api/rooms/${room.roomId}/join`, {
    inviteSecret: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toBe("bad-invite");
});

test("failure: an expired ticket cannot upgrade", async () => {
  const room = await createRoom();
  const p = await joinOk(room);
  const sessionTokenHash = await sha256B64(p.sessionToken);
  // Issue 31 seconds in the past so the stored expiry is already gone.
  const issued = await stubFor(room.roomId).issueTicket({
    sessionTokenHash,
    nowMs: Date.now() - 31_000,
  });
  const up = await upgrade(`/api/rooms/${room.roomId}/ws?ticket=${issued.ticket}`);
  expect(up.status).toBe(401);
});

test("failure: a consumed ticket cannot upgrade twice", async () => {
  const room = await createRoom();
  const p = await joinOk(room);
  const t = await ticketOk(room.roomId, p.sessionToken);
  expect((await upgrade(`/api/rooms/${room.roomId}/ws?ticket=${t.ticket}`)).status).toBe(101);
  expect((await upgrade(`/api/rooms/${room.roomId}/ws?ticket=${t.ticket}`)).status).toBe(401);
});

test("failure: a ticket for room A cannot join room B", async () => {
  const a = await createRoom();
  const b = await createRoom();
  const pa = await joinOk(a);
  const t = await ticketOk(a.roomId, pa.sessionToken);
  expect((await upgrade(`/api/rooms/${b.roomId}/ws?ticket=${t.ticket}`)).status).toBe(401);
});

test("failure: self-declared playerId and host flags are ignored", async () => {
  const room = await createRoom();
  const p = await joinOk(room, { playerId: "fakehost", host: true, joinOrder: 0 });
  expect(p.playerId).not.toBe("fakehost");
  expect(p.playerId).toMatch(/^[A-Za-z0-9_-]{22}$/);
});

test("failure: cross-origin join and upgrade are refused", async () => {
  const room = await createRoom();
  const foreign = await post(
    `/api/rooms/${room.roomId}/join`,
    { inviteSecret: room.inviteSecret },
    EVIL_ORIGIN,
  );
  expect(foreign.status).toBe(403);
  const p = await joinOk(room);
  const t = await ticketOk(room.roomId, p.sessionToken);
  const foreignUp = await upgrade(`/api/rooms/${room.roomId}/ws?ticket=${t.ticket}`, EVIL_ORIGIN);
  expect(foreignUp.status).toBe(403);
  // Refused before the DO — the ticket was never consumed.
  expect((await upgrade(`/api/rooms/${room.roomId}/ws?ticket=${t.ticket}`)).status).toBe(101);
});

test("failure: a join body over 16KiB is refused", async () => {
  const room = await createRoom();
  const res = await post(`/api/rooms/${room.roomId}/join`, {
    inviteSecret: room.inviteSecret,
    padding: "x".repeat(17 * 1024),
  });
  expect(res.status).toBe(413);
});

test("failure: secrets never ride the query and only hashes persist", async () => {
  const room = await createRoom();
  // An invite secret smuggled via query instead of the body is not a join.
  const sneaky = await SELF.fetch(
    `${BASE}/api/rooms/${room.roomId}/join?inviteSecret=${room.inviteSecret}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: GOOD_ORIGIN },
      body: "{}",
    },
  );
  expect(sneaky.status).toBe(422);

  const p = await joinOk(room);
  const rows = await runInDurableObject(stubFor(room.roomId), (_i, ctx) => ({
    auth: ctx.storage.sql.exec("SELECT invite_hash FROM room_auth").toArray(),
    players: ctx.storage.sql
      .exec("SELECT session_hash, reconnect_hash FROM room_players")
      .toArray(),
  }));
  const storedInvite = rows.auth[0]?.invite_hash;
  expect(storedInvite).toBe(await sha256B64(room.inviteSecret));
  expect(storedInvite).not.toBe(room.inviteSecret);
  const player = rows.players[0];
  expect(player?.session_hash).toBe(await sha256B64(p.sessionToken));
  expect(player?.reconnect_hash).toBe(await sha256B64(p.reconnectToken));
  expect(player?.session_hash).not.toBe(p.sessionToken);
  expect(player?.reconnect_hash).not.toBe(p.reconnectToken);
});
