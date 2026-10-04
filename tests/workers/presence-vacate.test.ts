// Departed-member seat release: a lost connection in the lobby vacates
// the seat OUTRIGHT — memberLeft broadcasts, the ready flag drops, and
// the seat's choice draft moves to the orphan tail so the next member
// never inherits the label. Mid-game the roster survives for reconnect;
// the reopen commit (lifecycle-commit) vacates any ghosts as the room
// becomes a lobby again.
import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import type { ServerEnvelope } from "@yuragoo/protocol";
import { deliverAlarm, execSql, type RoomStub } from "./room-helpers";
import { armedStart, latestLobby, setupRoom, Sock, type Joined } from "./ws-helpers";

const isType = (t: ServerEnvelope["type"]) => (e: ServerEnvelope) => e.type === t;
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
const memberRows = (stub: RoomStub, playerId: string) =>
  execSql(stub, "SELECT COUNT(*) AS n FROM room_players WHERE player_id = ?", playerId);
const until = async <T>(probe: () => Promise<T | null>, ms = 8_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("probe timed out");
    await new Promise((r) => setTimeout(r, 60));
  }
};

const connectTwo = async (roomId: string, h: Joined, a: Joined): Promise<[Sock, Sock]> => {
  const sh = await Sock.connect(roomId, h.sessionToken);
  const sa = await Sock.connect(roomId, a.sessionToken);
  return [sh, sa];
};

test("lobby disconnect vacates the seat: ready strip, draft to orphan tail, re-elect", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = [joins[0], joins[1]];
  if (!h || !a) throw new Error("joins missing");
  const [sh, sa] = await connectTwo(room.roomId, h, a);
  const stub = roomStubOf(room.roomId);
  await pinLeases(stub);
  const lobby = latestLobby(sh);
  if (lobby === null) throw new Error("no lobby");
  sh.sendCmd(room.roomId, "edit", "updateLobbyContent", {
    expectedLobbyRevision: lobby.revision,
    choices: lobby.choices.map((c, i) => ({ choiceId: c.choiceId, label: `案${i}` })),
  });
  await sh.next(ackFor("edit"));
  sa.sendCmd(room.roomId, "rdy", "setReady", { ready: true });
  await sa.next(ackFor("rdy"));
  sh.close();
  await sa.next(memberLeft(h.playerId));
  await sa.next(hostIs(a.playerId)); // h was host — election moves it
  expect((await memberRows(stub, h.playerId))[0]?.n).toBe(0);
  // The leaver's draft moved to the orphan tail — seat 0 keeps a's label.
  const after = latestLobby(sa);
  expect(after?.ready).not.toContain(h.playerId);
  expect(after?.choices.map((c) => c.label)).toEqual(["案1", "案0"]);
  sa.close();
});

test("mid-game disconnect keeps the seat — a reconnect restores presence", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = [joins[0], joins[1]];
  if (!h || !a) throw new Error("joins missing");
  const [sh, sa] = await connectTwo(room.roomId, h, a);
  await armedStart(room, [sh, sa], "vac-start", {
    mode: "turn",
    seed: 7,
    turnSeconds: 30,
    rounds: 2,
  });
  await sh.next(ackFor("vac-start"));
  sh.close();
  await sa.next(presence(h.playerId, false));
  expect(sa.count(memberLeft(h.playerId))).toBe(0);
  const stub = roomStubOf(room.roomId);
  expect((await memberRows(stub, h.playerId))[0]?.n).toBe(1);
  const sh2 = await Sock.connect(room.roomId, h.sessionToken);
  await sa.next(presence(h.playerId, true));
  sh2.close();
  sa.close();
});

test("backToLobby vacates mid-game ghosts in the same commit", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = [joins[0], joins[1]];
  if (!h || !a) throw new Error("joins missing");
  const [sh, sa] = await connectTwo(room.roomId, h, a);
  const stub = roomStubOf(room.roomId);
  await armedStart(room, [sh, sa], "go", {
    mode: "turn",
    seed: 7,
    turnSeconds: 30,
    settleSeconds: 2,
    hostDecision: true,
  });
  await sh.next(ackFor("go"));
  sh.close(); // h drops mid-game — the roster keeps the seat
  await sa.next(presence(h.playerId, false));
  // a is the host now (h dropped): drive the game to finished.
  sa.sendCmd(room.roomId, "end", "requestDecision", {});
  await sa.next(ackFor("end"));
  await until(async () => {
    await deliverAlarm(stub);
    const row = await execSql(stub, "SELECT phase FROM room_meta WHERE id = 1");
    return row[0]?.phase === "finished" ? true : null;
  });
  sa.sendCmd(room.roomId, "back", "backToLobby", {});
  await sa.next(memberLeft(h.playerId)); // the ghost vacates in this commit
  await sa.next(isType("lobbyReopened"));
  expect((await memberRows(stub, h.playerId))[0]?.n).toBe(0);
  // armLobby labelled the rows 選択肢1/選択肢2 — h's draft orphaned last.
  expect(latestLobby(sa)?.choices.map((c) => c.label)).toEqual(["選択肢2", "選択肢1"]);
  sa.close();
});

test("a silent drop vacates the lobby member via the lease sweep", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = [joins[0], joins[1]];
  if (!h || !a) throw new Error("joins missing");
  const [sh, sa] = await connectTwo(room.roomId, h, a);
  const stub = roomStubOf(room.roomId);
  await pinLeases(stub);
  // h's lease lapses without a close event — the alarm sweep detects it.
  await execSql(
    stub,
    "UPDATE room_players SET lease_until_ms = ? WHERE player_id = ?",
    Date.now() - 1,
    h.playerId,
  );
  await execSql(stub, "UPDATE deadlines SET run_at = ? WHERE id = 'lease-sweep'", Date.now() - 1);
  await deliverAlarm(stub);
  await sa.next(memberLeft(h.playerId));
  expect((await memberRows(stub, h.playerId))[0]?.n).toBe(0);
  sh.close();
  sa.close();
});
