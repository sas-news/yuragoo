// Departed-member seat release (Task 48d): a disconnect arms a
// vacate:<playerId> deadline at now + VACATE_GRACE_MS. Fired in the
// lobby it deletes the member row outright — memberLeft broadcasts, the
// ready flag drops, the seat draft orphans — so a real departure stops
// blocking startGame. Re-admission deletes the row, and a game in
// flight re-arms it (roster integrity wins until the lobby returns).
import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import type { ServerEnvelope } from "@yuragoo/protocol";
import { deadlineRows, deliverAlarm, execSql, type RoomStub } from "./room-helpers";
import { armedStart, latestLobby, setupRoom, Sock, type Joined } from "./ws-helpers";

const presence = (playerId: string, connected: boolean) => (e: ServerEnvelope) =>
  e.type === "presenceChanged" &&
  e.payload.playerId === playerId &&
  e.payload.connected === connected;
const memberLeft = (playerId: string) => (e: ServerEnvelope) =>
  e.type === "memberLeft" && e.payload.playerId === playerId;
const hostIs = (playerId: string) => (e: ServerEnvelope) =>
  e.type === "hostChanged" && e.payload.playerId === playerId;
const ackFor = (id: string) => (e: ServerEnvelope) =>
  e.type === "ack" && e.payload.commandId === id;

const roomStubOf = (roomId: string): RoomStub =>
  env.GAME_ROOM.get(env.GAME_ROOM.idFromString(roomId));

const pinLeases = (stub: RoomStub) =>
  execSql(stub, "UPDATE room_players SET lease_until_ms = ?", Date.now() + 3_600_000);

const vacateId = (playerId: string) => `vacate:${playerId}`;
const forceDue = (stub: RoomStub, playerId: string) =>
  execSql(stub, "UPDATE deadlines SET run_at = ? WHERE id = ?", Date.now() - 1, vacateId(playerId));
const memberRows = (stub: RoomStub, playerId: string) =>
  execSql(stub, "SELECT COUNT(*) AS n FROM room_players WHERE player_id = ?", playerId);

const connectTwo = async (roomId: string, h: Joined, a: Joined): Promise<[Sock, Sock]> => {
  const sh = await Sock.connect(roomId, h.sessionToken);
  const sa = await Sock.connect(roomId, a.sessionToken);
  return [sh, sa];
};

test("disconnect arms vacate; firing it vacates the seat, strips ready and re-elects", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = [joins[0], joins[1]];
  if (!h || !a) throw new Error("joins missing");
  const [sh, sa] = await connectTwo(room.roomId, h, a);
  const stub = roomStubOf(room.roomId);
  await pinLeases(stub);
  sa.sendCmd(room.roomId, "rdy", "setReady", { ready: true });
  await sa.next(ackFor("rdy"));
  sh.close();
  await sa.next(presence(h.playerId, false));
  // The deadline was armed at disconnect — backdate and deliver.
  const armed = (await deadlineRows(stub)).find((d) => d.id === vacateId(h.playerId));
  expect(armed).toBeDefined();
  await forceDue(stub, h.playerId);
  await deliverAlarm(stub);
  await sa.next(memberLeft(h.playerId));
  await sa.next(hostIs(a.playerId)); // h was host — election moves it
  expect((await memberRows(stub, h.playerId))[0]?.n).toBe(0);
  // The ready list forgets the departed member — the gate can pass again.
  const lobby = latestLobby(sa);
  expect(lobby?.ready).not.toContain(h.playerId);
  sa.close();
});

test("a re-admitted member keeps the seat — the vacate deadline dies", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = [joins[0], joins[1]];
  if (!h || !a) throw new Error("joins missing");
  const [sh, sa] = await connectTwo(room.roomId, h, a);
  const stub = roomStubOf(room.roomId);
  await pinLeases(stub);
  sh.close();
  await sa.next(presence(h.playerId, false));
  const sh2 = await Sock.connect(room.roomId, h.sessionToken);
  await sa.next(presence(h.playerId, true));
  // admit() deleted the vacate row — firing it later would be a no-op.
  const rows = (await deadlineRows(stub)).filter((d) => d.id === vacateId(h.playerId));
  expect(rows).toHaveLength(0);
  sh2.close();
  sa.close();
});

test("a game in flight re-arms the vacate deadline instead of vacating", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = [joins[0], joins[1]];
  if (!h || !a) throw new Error("joins missing");
  const [sh, sa] = await connectTwo(room.roomId, h, a);
  const stub = roomStubOf(room.roomId);
  await armedStart(room, [sh, sa], "vac-start", {
    mode: "turn",
    seed: 7,
    turnSeconds: 30,
    rounds: 2,
  });
  await sh.next(ackFor("vac-start"));
  sh.close();
  await sa.next(presence(h.playerId, false));
  await forceDue(stub, h.playerId);
  await deliverAlarm(stub);
  // Roster protection: the member survives, the deadline re-arms future.
  expect((await memberRows(stub, h.playerId))[0]?.n).toBe(1);
  const rearmed = (await deadlineRows(stub)).find((d) => d.id === vacateId(h.playerId));
  expect(rearmed?.runAt).toBeGreaterThan(Date.now());
  expect(sa.count(memberLeft(h.playerId))).toBe(0);
  sa.close();
});
