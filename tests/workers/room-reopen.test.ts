// Task 29: the finished-game -> lobby lifecycle, end to end through real
// WebSocketPair clients + SQL probes. backToLobby tears the game ledger
// down in ONE commit (never an instant rematch), the meta-less room
// recovers via room_auth, leave in the finished state re-elects the
// host, and transferHost hands the seat over explicitly.
import { env, evictDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { ServerEnvelope } from "@yuragoo/protocol";
import { deliverAlarm, execSql, type RoomStub } from "./room-helpers";
import {
  armLobby,
  armedStart,
  type Created,
  joinRoom,
  latestLobby,
  setupRoom,
  Sock,
} from "./ws-helpers";

const isType = (t: ServerEnvelope["type"]) => (e: ServerEnvelope) => e.type === t;
const isError = (code: string) => (e: ServerEnvelope) =>
  e.type === "error" && e.payload.code === code;
const ackFor = (id: string) => (e: ServerEnvelope) =>
  e.type === "ack" && e.payload.commandId === id;
const hostIs = (playerId: string) => (e: ServerEnvelope) =>
  e.type === "hostChanged" && e.payload.playerId === playerId;

const roomStubOf = (roomId: string): RoomStub =>
  env.GAME_ROOM.get(env.GAME_ROOM.idFromString(roomId));

const until = async <T>(probe: () => Promise<T | null>, ms = 8_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("probe timed out");
    await new Promise((r) => setTimeout(r, 60));
  }
};

// Drive a started game to `finished`: the host calls requestDecision
// (hostDecision is armed in the lobby settings) and the settle alarm
// fires the real 2s window — same path as room-presence's settle test.
const finish = async (room: Created, stub: RoomStub, socks: Sock[]): Promise<void> => {
  await armedStart(room, socks, "go", {
    mode: "turn",
    seed: 7,
    turnSeconds: 30,
    settleSeconds: 2,
    hostDecision: true,
  });
  const host = socks[0];
  if (host === undefined) throw new Error("host missing");
  await host.next(ackFor("go"));
  host.sendCmd(room.roomId, "end-1", "requestDecision", {});
  await host.next(ackFor("end-1"));
  await until(async () => {
    await deliverAlarm(stub);
    const row = await execSql(stub, "SELECT phase FROM room_meta WHERE id = 1");
    return row[0]?.phase === "finished" ? true : null;
  });
};

test("finished -> backToLobby reopens a clean lobby; a fresh game starts", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = joins;
  if (!h || !a) throw new Error("joins missing");
  const sh = await Sock.connect(room.roomId, h.sessionToken);
  const sa = await Sock.connect(room.roomId, a.sessionToken);
  const stub = roomStubOf(room.roomId);
  await finish(room, stub, [sh, sa]);
  // A mid-game joiner sits in the roster as lobbyWaiting — the reopen
  // promotes them and grows their choice row in the same commit.
  const late = await joinRoom(room);
  expect(late.lobbyWaiting).toBe(true);
  await sh.next((e) => e.type === "memberJoined" && e.payload.lobbyWaiting === true);
  // The MEMBER (not the host) sends it — any member may reopen.
  sa.sendCmd(room.roomId, "back-1", "backToLobby", {});
  await sa.next(ackFor("back-1"));
  const reopened = await sh.next(isType("lobbyReopened"));
  if (reopened.type !== "lobbyReopened") throw new Error("lobbyReopened missing");
  expect(reopened.payload.scenario).toBe("夜のおやつ会議");
  expect(reopened.payload.ready).toEqual([]);
  expect(reopened.payload.committedCount).toBe(0);
  expect(reopened.payload.choices).toHaveLength(3); // grown for the joiner
  // The game ledger is gone outright — a "null" snapshot would brick
  // recovery; room_auth alone marks the room alive.
  const meta = await execSql(stub, "SELECT * FROM room_meta");
  expect(meta).toHaveLength(0);
  // A fresh connection sees a pure lobby snapshot: phase lobby, no game.
  const sc = await Sock.connect(room.roomId, late.sessionToken);
  const snap = sc.log.find(isType("snapshot"));
  if (snap?.type !== "snapshot") throw new Error("snapshot missing");
  expect(snap.payload.phase).toBe("lobby");
  expect(snap.payload.state).toBeNull();
  expect(snap.payload.players.every((p) => !p.lobbyWaiting)).toBe(true);
  // The room is reusable: re-ready + startGame lands a fresh epoch.
  await armLobby(room, [sh, sa, sc], undefined, "re");
  sh.sendCmd(room.roomId, "go-2", "startGame", {});
  await sh.next(ackFor("go-2"));
  for (const s of [sh, sa, sc]) await s.next(isType("phaseChanged"));
  for (const s of [sh, sa, sc]) s.close();
});

test("the reopened lobby survives a DO restart and still starts", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = joins;
  if (!h || !a) throw new Error("joins missing");
  const sh = await Sock.connect(room.roomId, h.sessionToken);
  const sa = await Sock.connect(room.roomId, a.sessionToken);
  const stub = roomStubOf(room.roomId);
  await finish(room, stub, [sh, sa]);
  sh.sendCmd(room.roomId, "back-2", "backToLobby", {});
  await sh.next(ackFor("back-2"));
  // Eviction stands in for the lost isolate — recovery must read the
  // meta-less room as a live lobby (room_auth), never as corruption.
  await evictDurableObject(stub);
  const sh2 = await Sock.connect(room.roomId, h.sessionToken);
  const sa2 = await Sock.connect(room.roomId, a.sessionToken);
  const snap = sh2.log.find(isType("snapshot"));
  if (snap?.type !== "snapshot") throw new Error("snapshot missing");
  expect(snap.payload.phase).toBe("lobby");
  await armLobby(room, [sh2, sa2], undefined, "re");
  sh2.sendCmd(room.roomId, "go-3", "startGame", {});
  await sh2.next(ackFor("go-3"));
  for (const s of [sh2, sa2]) await s.next(isType("phaseChanged"));
  for (const s of [sh, sa, sh2, sa2]) s.close();
});

test("finished: the host's leave re-elects; mid-game leave stays refused", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = joins;
  if (!h || !a) throw new Error("joins missing");
  const sh = await Sock.connect(room.roomId, h.sessionToken);
  const sa = await Sock.connect(room.roomId, a.sessionToken);
  const stub = roomStubOf(room.roomId);
  await armedStart(room, [sh, sa], "go-mid", {
    mode: "turn",
    seed: 7,
    turnSeconds: 30,
    settleSeconds: 2,
    hostDecision: true,
  });
  await sh.next(ackFor("go-mid"));
  // A roster member cannot walk out mid-game.
  sh.sendCmd(room.roomId, "leave-mid", "leave", {});
  expect((await sh.next(isError("bad-state"))).type).toBe("error");
  // Once finished the same command commits and the host seat re-elects.
  sh.sendCmd(room.roomId, "end-2", "requestDecision", {});
  await sh.next(ackFor("end-2"));
  await until(async () => {
    await deliverAlarm(stub);
    const row = await execSql(stub, "SELECT phase FROM room_meta WHERE id = 1");
    return row[0]?.phase === "finished" ? true : null;
  });
  sh.sendCmd(room.roomId, "leave-fin", "leave", {});
  await sh.next(ackFor("leave-fin"));
  await sa.next((e) => e.type === "memberLeft" && e.payload.playerId === h.playerId);
  await sa.next(hostIs(a.playerId));
  sa.close();
});

test("transferHost: host-only, another connected member, persists + retargets", async () => {
  const { room, joins } = await setupRoom(3);
  const [h, a, b] = joins;
  if (!h || !a || !b) throw new Error("joins missing");
  const sh = await Sock.connect(room.roomId, h.sessionToken);
  const sa = await Sock.connect(room.roomId, a.sessionToken);
  const sb = await Sock.connect(room.roomId, b.sessionToken);
  const stub = roomStubOf(room.roomId);
  // Non-host, self and unknown id all refuse cleanly.
  sa.sendCmd(room.roomId, "t-nh", "transferHost", { playerId: b.playerId });
  expect((await sa.next(isError("not-host"))).type).toBe("error");
  sh.sendCmd(room.roomId, "t-self", "transferHost", { playerId: h.playerId });
  expect((await sh.next(isError("not-a-member"))).type).toBe("error");
  sh.sendCmd(room.roomId, "t-miss", "transferHost", { playerId: "nobody" });
  expect((await sh.next(isError("not-a-member"))).type).toBe("error");
  // The real hand-off: one commit persists the presence row and the
  // hostChanged broadcast reaches every connected member.
  sh.sendCmd(room.roomId, "t-ok", "transferHost", { playerId: a.playerId });
  await sh.next(ackFor("t-ok"));
  for (const s of [sa, sb]) await s.next(hostIs(a.playerId));
  const row = await execSql(stub, "SELECT host_player_id FROM room_presence WHERE id = 1");
  expect(row[0]?.host_player_id).toBe(a.playerId);
  // Authority moved: the old host can no longer edit, the new one can.
  sh.sendCmd(room.roomId, "e-old", "updateLobbyContent", {
    scenario: "旧ホストの編集",
    expectedLobbyRevision: latestLobby(sh)?.revision ?? 0,
  });
  expect((await sh.next(isError("not-host"))).type).toBe("error");
  sa.sendCmd(room.roomId, "e-new", "updateLobbyContent", {
    scenario: "新ホストの編集",
    expectedLobbyRevision: latestLobby(sa)?.revision ?? 0,
  });
  await sa.next(ackFor("e-new"));
  // An offline target refuses — every command lazily sweeps lapsed
  // leases, so this probe runs LAST: the lobby sweep vacates b outright
  // (not just offline), so the target reads as a non-member.
  await execSql(
    stub,
    "UPDATE room_players SET lease_until_ms = ? WHERE player_id = ?",
    Date.now() - 1,
    b.playerId,
  );
  sa.sendCmd(room.roomId, "t-off", "transferHost", { playerId: b.playerId });
  expect((await sa.next(isError("not-a-member"))).type).toBe("error");
  for (const s of [sh, sa, sb]) s.close();
});
