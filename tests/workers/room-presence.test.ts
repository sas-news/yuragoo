// Task 20: presence, host election, lease expiry and the empty-room
// pause/resume — end-to-end through real WebSocketPair clients plus SQL
// probes into room_presence / deadlines / paused_deadlines. Test timings
// are compressed by vitest.workers.config bindings (10s lease / 3s empty
// grace); expiry is forced by backdating rows, so no test sleeps on a clock.
import { env, SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import type { ServerEnvelope } from "@yuragoo/protocol";
import { deadlineRows, deliverAlarm, execSql, type RoomStub } from "./room-helpers";
import { armedStart, joinRoom, setupRoom, Sock, type Joined } from "./ws-helpers";

const isType = (t: ServerEnvelope["type"]) => (e: ServerEnvelope) => e.type === t;
const presence = (playerId: string, connected: boolean) => (e: ServerEnvelope) =>
  e.type === "presenceChanged" &&
  e.payload.playerId === playerId &&
  e.payload.connected === connected;
const hostIs = (playerId: string) => (e: ServerEnvelope) =>
  e.type === "hostChanged" && e.payload.playerId === playerId;
const memberLeft = (playerId: string) => (e: ServerEnvelope) =>
  e.type === "memberLeft" && e.payload.playerId === playerId;
const ackFor = (id: string) => (e: ServerEnvelope) =>
  e.type === "ack" && e.payload.commandId === id;

type PresenceRow = {
  host_player_id: string | null;
  empty_since_ms: number | null;
  paused_at_ms: number | null;
  expired: number;
};
const presenceRow = async (stub: RoomStub): Promise<PresenceRow> =>
  (await execSql(stub, "SELECT * FROM room_presence WHERE id = 1"))[0] as unknown as PresenceRow;

const pinLeases = (stub: RoomStub) =>
  execSql(stub, "UPDATE room_players SET lease_until_ms = ?", Date.now() + 3_600_000);

const roomStubOf = (roomId: string): RoomStub =>
  env.GAME_ROOM.get(env.GAME_ROOM.idFromString(roomId));

// Sequential: the sticky election seats the first-admitted socket as
// host, so these tests admit in join order — concurrent connects race.
const connectTwo = async (roomId: string, h: Joined, a: Joined): Promise<[Sock, Sock]> => {
  const sh = await Sock.connect(roomId, h.sessionToken);
  const sa = await Sock.connect(roomId, a.sessionToken);
  return [sh, sa];
};

// Poll, never a fixed sleep — close events reach the DO asynchronously.
const until = async <T>(probe: () => Promise<T | null>, ms = 4_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("probe timed out");
    await new Promise((r) => setTimeout(r, 40));
  }
};

const emptied = (stub: RoomStub): Promise<PresenceRow> =>
  until(async () => {
    const p = await presenceRow(stub);
    return p.empty_since_ms === null ? null : p;
  });

test("host disconnect elects the oldest connected member; a returning host stays non-host", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = [joins[0], joins[1]];
  if (!h || !a) throw new Error("joins missing");
  const [sh, sa] = await connectTwo(room.roomId, h, a);
  const stub = roomStubOf(room.roomId);
  await pinLeases(stub);
  await armedStart(room, [sh, sa], "t20-host", {
    mode: "turn",
    seed: 7,
    turnSeconds: 30,
    rounds: 2,
  });
  await sh.next(ackFor("t20-host"));
  // b is a never-connected lobbyWaiting invite holder — unelectable.
  const b = await joinRoom(room);
  expect(b.lobbyWaiting).toBe(true);
  await sa.next(isType("memberJoined"));
  sh.close();
  await sa.next(presence(h.playerId, false));
  const elected = await sa.next(isType("hostChanged"));
  if (elected.type !== "hostChanged") throw new Error("expected hostChanged");
  expect(elected.payload.playerId).toBe(a.playerId); // oldest connected, not invite-holder b
  expect(sa.count(memberLeft(h.playerId))).toBe(0); // mid-game: roster survives
  // The returning old host re-admits as a plain member — host stays with a.
  const sh2 = await Sock.connect(room.roomId, h.sessionToken);
  const snap = sh2.log.find(isType("snapshot"));
  if (snap?.type !== "snapshot") throw new Error("snapshot missing");
  expect(snap.payload.hostPlayerId).toBe(a.playerId);
  await sa.next(presence(h.playerId, true));
  expect(sa.count(isType("hostChanged"))).toBe(1); // still only the first transfer
  sh2.close();
  sa.close();
});

test("empty room persists emptySince and parks only playing deadlines; rejoin shifts them", {
  timeout: 30_000,
}, async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = [joins[0], joins[1]];
  if (!h || !a) throw new Error("joins missing");
  const [sh, sa] = await connectTwo(room.roomId, h, a);
  const stub = roomStubOf(room.roomId);
  await armedStart(room, [sh, sa], "t20-start", {
    mode: "turn",
    seed: 7,
    turnSeconds: 30,
    rounds: 2,
  });
  await sh.next(ackFor("t20-start"));
  await sa.next(isType("phaseChanged"));
  const before = await deadlineRows(stub);
  const turn = before.find((d) => d.tag === "turn");
  if (turn === undefined) throw new Error("turn deadline missing");
  sh.close();
  sa.close();
  // All connections gone: the room is empty, paused and grace-armed.
  const p = await emptied(stub);
  expect(p.paused_at_ms).toBe(p.empty_since_ms); // playing phase -> paused
  const parked = await execSql(stub, "SELECT id, remaining_ms, tag FROM paused_deadlines");
  expect(parked.map((r) => r.tag)).toEqual(["turn"]);
  const tags = (await deadlineRows(stub)).map((d) => d.tag).sort();
  expect(tags).toEqual(["room-expiry"]); // mid-game ghosts keep their seat
  // Rejoin inside the grace window: the turn clock resumes shifted by the
  // paused duration; the expiry row is gone and presence flips back.
  const sa2 = await Sock.connect(room.roomId, a.sessionToken);
  const after = await deadlineRows(stub);
  const shifted = after.find((d) => d.tag === "turn");
  if (shifted === undefined) throw new Error("turn deadline was not resumed");
  const delta = shifted.runAt - turn.runAt;
  expect(delta).toBeGreaterThan(0);
  expect(delta).toBeLessThanOrEqual(Date.now() - (p.paused_at_ms ?? 0) + 500);
  expect(shifted.runAt).toBeGreaterThan(Date.now() + 20_000); // ~30s clock, not reset
  const resumed = await presenceRow(stub);
  expect(resumed.empty_since_ms).toBeNull();
  expect(resumed.paused_at_ms).toBeNull();
  const snap = sa2.log.find(isType("snapshot"));
  if (snap?.type !== "snapshot") throw new Error("snapshot missing");
  expect(snap.payload.players.find((x) => x.playerId === a.playerId)?.connected).toBe(true);
  sa2.close();
});

test("rejoin after the empty grace window is refused at every entrypoint", {
  timeout: 30_000,
}, async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = [joins[0], joins[1]];
  if (!h || !a) throw new Error("joins missing");
  const socks = await connectTwo(room.roomId, h, a);
  const stub = roomStubOf(room.roomId);
  for (const s of socks) s.close();
  await emptied(stub); // close events must land before the backdate sticks
  await execSql(stub, "UPDATE room_presence SET empty_since_ms = empty_since_ms - 100000");
  // Session -> ticket refuses: the guard runs inside issueTicket.
  await expect(Sock.connect(room.roomId, a.sessionToken)).rejects.toThrow("410");
  const res = await SELF.fetch(`https://ws.test/api/rooms/${room.roomId}/reconnect`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({ reconnectToken: h.reconnectToken }),
  });
  expect(res.status).toBe(410); // reconnect refuses too
  await expect(joinRoom(room)).rejects.toThrow("410"); // join refuses
  expect((await presenceRow(stub)).expired).toBe(1); // terminal marker persisted
});

test("a silent drop is swept by the lease-sweep alarm and the host transfers", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = [joins[0], joins[1]];
  if (!h || !a) throw new Error("joins missing");
  const [sh, sa] = await connectTwo(room.roomId, h, a);
  const stub = roomStubOf(room.roomId);
  await pinLeases(stub);
  // Silent drop: h's lease lapses with no close event (sweep detects it;
  // memberLeft/row-delete detail lives in presence-vacate).
  await execSql(
    stub,
    "UPDATE room_players SET lease_until_ms = ? WHERE player_id = ?",
    Date.now() - 1,
    h.playerId,
  );
  await execSql(stub, "UPDATE deadlines SET run_at = ? WHERE id = 'lease-sweep'", Date.now() - 1);
  await deliverAlarm(stub);
  await sa.next(memberLeft(h.playerId));
  await sa.next(hostIs(a.playerId));
  const closed = await sh.waitClose(); // dead socket closes lease-expired
  expect(closed.reason).toBe("lease-expired");
  sa.close();
});

test("a replaced socket's late close never clears the new socket's presence", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = [joins[0], joins[1]];
  if (!h || !a) throw new Error("joins missing");
  const sa = await Sock.connect(room.roomId, a.sessionToken);
  const s1 = await Sock.connect(room.roomId, h.sessionToken);
  const stub = roomStubOf(room.roomId);
  await pinLeases(stub);
  // Re-admit h on a second socket: the generation bump replaces s1.
  const s2 = await Sock.connect(room.roomId, h.sessionToken);
  const closed = await s1.waitClose();
  expect(closed.reason).toBe("replaced");
  // Give the stale close event room to land; h must stay connected.
  await new Promise((r) => setTimeout(r, 250));
  expect(sa.count(presence(h.playerId, false))).toBe(0);
  s2.sendCmd(room.roomId, "hb-2", "heartbeat", {});
  await s2.next(ackFor("hb-2")); // lease still live
  s2.close();
  sa.close();
});

test("settling is never paused: the settle deadline survives an empty room and still fires", {
  timeout: 30_000,
}, async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = [joins[0], joins[1]];
  if (!h || !a) throw new Error("joins missing");
  const [sh, sa] = await connectTwo(room.roomId, h, a);
  const stub = roomStubOf(room.roomId);
  await armedStart(room, [sh, sa], "t20-s", {
    mode: "turn",
    seed: 7,
    turnSeconds: 30,
    settleSeconds: 2, // short real settle window so the alarm fires soon
    hostDecision: true, // Task 26: requestDecision below needs the switch on
  });
  await sh.next(ackFor("t20-s"));
  sh.sendCmd(room.roomId, "t20-end", "requestDecision", {});
  await sh.next(ackFor("t20-end"));
  const settle = (await deadlineRows(stub)).find((d) => d.tag === "settle");
  if (settle === undefined) throw new Error("settle deadline missing");
  sh.close();
  sa.close();
  const p = await emptied(stub);
  expect(p.paused_at_ms).toBeNull(); // complete phase -> nothing parks
  const still = (await deadlineRows(stub)).find((d) => d.tag === "settle");
  expect(still?.runAt).toBe(settle.runAt); // identical, unshifted
  // Settle completes once unattended: wait out the real 2s window (the
  // row fires only on schedule) — the game finishes with nobody connected.
  await until(async () => {
    await deliverAlarm(stub);
    const row = await execSql(stub, "SELECT phase FROM room_meta WHERE id = 1");
    return row[0]?.phase === "finished" ? row[0].phase : null;
  });
  const snap = await execSql(stub, "SELECT phase FROM room_meta WHERE id = 1");
  expect(snap[0]?.phase).toBe("finished");
});
