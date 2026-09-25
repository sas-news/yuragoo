// Task 19: the versioned WS command protocol end-to-end through real
// WebSocketPair clients (SELF.fetch upgrade -> response.webSocket, parked
// on the DO via ctx.acceptWebSocket). Unique rooms per test — DO storage
// persists across the whole miniflare run.
import { expect, test } from "vitest";
import type { ServerEnvelope } from "@yuragoo/protocol";
import { armLobby, armedStart, setupRoom, Sock } from "./ws-helpers";

const isType = (type: ServerEnvelope["type"]) => (e: ServerEnvelope) => e.type === type;
const isError = (code: string) => (e: ServerEnvelope) =>
  e.type === "error" && e.payload.code === code;
const ackFor = (commandId: string) => (e: ServerEnvelope) =>
  e.type === "ack" && e.payload.commandId === commandId;

const two = async (players = 2) => {
  const { room, joins } = await setupRoom(players);
  // Sequential connects: the sticky election seats the FIRST admitted
  // socket as host, and these tests rely on joins[0] holding the seat.
  const socks: Sock[] = [];
  for (const j of joins) socks.push(await Sock.connect(room.roomId, j.sessionToken));
  return { room, joins, socks };
};

// The scripted join->upgrade->submitText flow also emits the protocol
// trace used for task-19-protocol-trace.json (single-line base64 marker).
test("happy: four sockets share one inputAccepted with identical seq and phase", async () => {
  const { room, joins, socks } = await two(4);
  const sent: { atMs: number; direction: string; frame: unknown }[] = [];
  for (const s of socks) {
    const snap = s.log.find(isType("snapshot"));
    expect(snap?.type).toBe("snapshot");
    if (snap?.type === "snapshot") {
      expect(snap.gameId).toBe(room.roomId);
      expect(snap.payload.players).toHaveLength(4);
      expect(snap.payload.state).toBeNull(); // no game until startGame
    }
  }

  // Host (joinOrder 0) starts the game; every socket sees the same events.
  // Task 26: settings ride updateLobby; startGame only confirms the view.
  const host = socks[0];
  if (host === undefined) throw new Error("host socket missing");
  await armLobby(room, socks, { mode: "turn", seed: 7, turnSeconds: 30, rounds: 2 });
  const start = host.cmd(room.roomId, "start-1", "startGame", {
    mode: "turn",
    seed: 7,
    turnSeconds: 30,
    rounds: 2,
  });
  sent.push({ atMs: Date.now(), direction: "client->server", frame: start });
  host.sendEnvelope(start);
  expect((await host.next(ackFor("start-1")))?.type).toBe("ack");
  const started = await Promise.all(socks.map((s) => s.next(isType("phaseChanged"))));
  for (const e of started) expect(e.gameEpoch).toBe(1);
  const turn = await host.next((e) => e.type === "phaseChanged" && e.payload.event.type === "turn");
  const turnPlayer =
    turn?.type === "phaseChanged" && turn.payload.event.type === "turn"
      ? turn.payload.event.playerId
      : "";
  const poster = socks[joins.findIndex((j) => j.playerId === turnPlayer)];
  if (poster === undefined) throw new Error("turn player socket missing");

  const cmd = poster.cmd(room.roomId, "post-1", "submitText", { text: "たべたい" });
  sent.push({ atMs: Date.now(), direction: "client->server", frame: cmd });
  poster.sendEnvelope(cmd);
  // One ack to the sender, one identical event to every socket.
  expect((await poster.next(ackFor("post-1")))?.type).toBe("ack");
  expect(poster.count(ackFor("post-1"))).toBe(1);
  const accepted = await Promise.all(socks.map((s) => s.next(isType("inputAccepted"))));
  expect(new Set(accepted.map((e) => e.eventSeq)).size).toBe(1);
  const phases = new Set(
    accepted.map((e) => {
      if (e.type !== "inputAccepted") throw new Error("wrong frame");
      return e.payload.phase;
    }),
  );
  expect(phases).toEqual(new Set(["playing"]));
  for (const e of accepted) {
    if (e.type !== "inputAccepted") throw new Error("wrong frame");
    expect(e.payload.event.type).toBe("posted");
    expect(e.payload.post?.text).toBe("たべたい");
  }
  // Full bidirectional trace: every frame every socket received (stamped at
  // receipt) plus the two client sends, in wall-clock order.
  const trace = [
    ...sent,
    ...socks.flatMap((s) =>
      s.log.map((frame) => ({
        atMs: s.stamps.get(frame) ?? 0,
        direction: "server->client",
        frame,
      })),
    ),
  ].sort((a, b) => a.atMs - b.atMs);
  console.log(`PROTOCOL_TRACE::${JSON.stringify(trace)}`);
  for (const s of socks) s.close();
});

test("happy: a syncRequest heals the client with a full snapshot", async () => {
  const { room, socks } = await two(2);
  const [a, b] = socks;
  if (a === undefined || b === undefined) throw new Error("sockets missing");
  await armedStart(room, socks, "start-2", { mode: "live", seed: 3, liveSeconds: 120 });
  await a.next(ackFor("start-2"));
  await a.next(isType("phaseChanged")); // epoch is 1 before the next command
  a.sendCmd(room.roomId, "post-2", "submitText", { text: "よろしく" });
  await a.next(ackFor("post-2"));
  await a.next(isType("inputAccepted"));
  // The client reports a gap -> the room replies with a full snapshot.
  a.sendCmd(room.roomId, "sync-1", "syncRequest", { lastEventSeq: 0 });
  const snap = await a.next((e) => e.type === "snapshot" && e.payload.state !== null);
  if (snap?.type !== "snapshot") throw new Error("expected snapshot");
  expect(snap.stateRevision).toBeGreaterThanOrEqual(2);
  expect(snap.payload.state?.posts).toHaveLength(1);
  expect(snap.payload.state?.phase).toBe("playing");
  a.close();
  b.close();
});

test("happy: only the host may startGame", async () => {
  const { room, socks } = await two(2);
  const [host, guest] = socks;
  if (host === undefined || guest === undefined) throw new Error("sockets missing");
  guest.sendCmd(room.roomId, "start-guest", "startGame", { mode: "turn", seed: 5 });
  expect((await guest.next(isError("not-host"))).type).toBe("error");
  expect(guest.count(isType("phaseChanged"))).toBe(0);
  await armedStart(room, socks, "start-host", { mode: "turn", seed: 5 });
  await host.next(ackFor("start-host"));
  await guest.next(isType("phaseChanged"));
  host.close();
  guest.close();
});

test("failure: a duplicate commandId replays the stored ack without a second event", async () => {
  const { room, socks } = await two(2);
  const [a, b] = socks;
  if (a === undefined || b === undefined) throw new Error("sockets missing");
  await armedStart(room, socks, "start-d", { mode: "live", seed: 9 });
  await a.next(ackFor("start-d"));
  await a.next(isType("phaseChanged"));
  const cmd = a.cmd(room.roomId, "dup-1", "submitText", { text: "おなじ" });
  a.sendEnvelope(cmd);
  const first = await a.next(ackFor("dup-1"));
  a.sendEnvelope(cmd); // identical redelivery
  const replay = await a.next((e) => ackFor("dup-1")(e) && e !== first);
  expect(replay?.payload).toEqual(first?.payload);
  expect(a.count(isType("inputAccepted"))).toBe(1);
  expect(b.count(isType("inputAccepted"))).toBe(1);
  a.close();
  b.close();
});

test("failure: the same commandId with a different payload is IDEMPOTENCY_CONFLICT", async () => {
  const { room, socks } = await two(2);
  const a = socks[0];
  if (a === undefined) throw new Error("socket missing");
  await armedStart(room, socks, "start-c", { mode: "live", seed: 9 });
  await a.next(ackFor("start-c"));
  await a.next(isType("phaseChanged"));
  a.sendCmd(room.roomId, "dup-2", "submitText", { text: "はじめ" });
  await a.next(ackFor("dup-2"));
  a.sendCmd(room.roomId, "dup-2", "submitText", { text: "ちがう" });
  expect((await a.next(isError("idempotency-conflict"))).type).toBe("error");
  expect(a.count(isType("inputAccepted"))).toBe(1);
  a.close();
  socks[1]?.close();
});

test("failure: oversized, wrong-version, stale-epoch, malformed and binary frames", async () => {
  const { room, joins, socks } = await two(2);
  const [a] = socks;
  if (a === undefined) throw new Error("socket missing");
  await armedStart(room, socks, "start-g", { mode: "live", seed: 4 });
  await a.next(ackFor("start-g"));

  // >16KiB frame -> error frame then close 1009.
  a.sendCmd(room.roomId, "big-1", "submitText", { text: "x".repeat(17 * 1024) });
  await a.next(isError("frame-too-large"));
  expect((await a.waitClose()).code).toBe(1009);

  // Fresh socket for the remaining guards (replaces the closed one).
  const b = await Sock.connect(room.roomId, joins[0]?.sessionToken ?? "");
  b.sendRaw("{not json");
  expect((await b.next(isError("malformed-json"))).type).toBe("error");
  b.sendRaw(new ArrayBuffer(8));
  expect((await b.next(isError("expected-text-frame"))).type).toBe("error");
  b.sendRaw(JSON.stringify({ protocolVersion: 1, type: "frobnicate", payload: {} }));
  expect((await b.next(isError("invalid-envelope"))).type).toBe("error");
  b.sendEnvelope({
    protocolVersion: 99,
    commandId: "v-1",
    gameId: room.roomId,
    expectedGameEpoch: b.epoch,
    type: "heartbeat",
    payload: {},
  });
  expect((await b.next(isError("unsupported-protocol"))).type).toBe("error");
  b.sendEnvelope({
    protocolVersion: 1,
    commandId: "stale-1",
    gameId: room.roomId,
    expectedGameEpoch: 0, // the game is already at epoch 1
    type: "heartbeat",
    payload: {},
  });
  expect((await b.next(isError("stale-epoch"))).type).toBe("error");
  expect(b.count(isType("inputAccepted"))).toBe(0);

  // Rate bound: 70 heartbeats inside the 10s window -> 64 acks + 6 rejects.
  for (let i = 0; i < 70; i += 1) {
    b.sendCmd(room.roomId, `hb-${i}`, "heartbeat", {});
  }
  const replies: ServerEnvelope[] = [];
  while (replies.length < 70) {
    replies.push(await b.next((e) => e.type === "ack" || e.type === "error"));
  }
  const acks = replies.filter((e) => e.type === "ack");
  const errors = replies.filter((e) => e.type === "error");
  expect(acks).toHaveLength(64);
  expect(errors).toHaveLength(6);
  for (const e of errors) {
    if (e.type === "error") expect(e.payload.code).toBe("rate-limited");
  }
  b.close();
  socks[1]?.close();
});

test("failure: a payload-declared playerId is ignored", async () => {
  const { room, joins, socks } = await two(2);
  const [a, b] = socks;
  if (a === undefined || b === undefined) throw new Error("sockets missing");
  await armedStart(room, socks, "start-p", { mode: "live", seed: 11 });
  await a.next(ackFor("start-p"));
  await b.next(isType("phaseChanged")); // b's epoch must be 1 before it sends
  // The non-host claims to be the host inside the payload — the server must
  // still post as the connection's own playerId.
  b.sendCmd(room.roomId, "fake-1", "submitText", {
    text: "ぼくです",
    playerId: joins[0]?.playerId ?? "nobody",
  });
  const accepted = await b.next(isType("inputAccepted"));
  if (accepted.type !== "inputAccepted" || accepted.payload.event.type !== "posted") {
    throw new Error("expected a posted inputAccepted");
  }
  expect(accepted.payload.event.playerId).toBe(joins[1]?.playerId);
  expect(accepted.payload.post?.playerId).toBe(joins[1]?.playerId);
  a.close();
  b.close();
});
