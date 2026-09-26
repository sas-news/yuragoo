// Task 39 release gate — the chaos/soak half. Exercises the real HTTP +
// WS surface under load (10 rooms x 6 members), alarm delivery mid-game,
// credential abuse and close atomicity. Wall-clock p95 numbers are a
// production-deploy measurement; here we assert structural invariants:
// identical ordered streams, durable state across alarm, refused
// credentials, and a wiped room that stays dead.
import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import type { ServerEnvelope } from "@yuragoo/protocol";
import { deadlineRows, deliverAlarm } from "./room-helpers";
import { assertWiped, postJson, roomStubOf } from "./room-deletion-helpers";
import { armLobby, createRoom, latestLobby, setupRoom, Sock } from "./ws-helpers";

const isAck =
  (cid: string) =>
  (e: ServerEnvelope): boolean =>
    e.type === "ack" && e.payload.commandId === cid;
const isType =
  (t: ServerEnvelope["type"]) =>
  (e: ServerEnvelope): boolean =>
    e.type === t;
// A posted input lands as an inputAccepted frame on every socket.
const posted = (e: ServerEnvelope): boolean =>
  e.type === "inputAccepted" && e.payload.event.type === "posted";

// Six-member room with every seat on a live socket. All joins happen
// BEFORE any socket connects, so the authoritative membership check is
// the snapshot's players list, not the memberJoined broadcast.
const sixUp = async () => {
  const { room, joins } = await setupRoom(6);
  const socks: Sock[] = [];
  for (const j of joins) socks.push(await Sock.connect(room.roomId, j.sessionToken));
  return { room, joins, socks };
};

test("load: 10 rooms x 6 members share one ordered lobby stream per room", async () => {
  const rooms = [];
  for (let i = 0; i < 10; i += 1) rooms.push(await sixUp());

  // Every member's snapshot lists the same six seats in join order.
  for (const { joins, socks } of rooms) {
    const order = joins.map((j) => j.playerId);
    for (const s of socks) {
      const snap = s.log.find((e) => e.type === "snapshot");
      if (snap?.type !== "snapshot") throw new Error("no snapshot frame");
      const ids = snap.payload.players.map((p) => p.playerId);
      expect(ids).toEqual(order);
    }
  }

  // One host edit lands on the SAME revision for all six members.
  for (const [i, { room, socks }] of rooms.entries()) {
    const host = socks[0];
    if (host === undefined) throw new Error("host missing");
    const lobby = latestLobby(host);
    if (lobby === null) throw new Error("lobby missing");
    host.sendCmd(room.roomId, `edit-${i}`, "updateLobbyContent", {
      scenario: `かおす会議 ${i}`,
      choices: lobby.choices.map((c, n) => ({ choiceId: c.choiceId, label: `卓${i}-${n}` })),
      expectedLobbyRevision: lobby.revision,
    });
    const landed = await Promise.all(socks.map((s) => s.next(isType("lobbyChanged"))));
    const payloads = landed.map((e) => {
      if (e.type !== "lobbyChanged") throw new Error("wrong frame");
      return e.payload;
    });
    const revisions = new Set(payloads.map((p) => p.revision));
    expect(revisions.size).toBe(1);
    const labels = payloads.map((p) => p.choices.map((c) => c.label));
    for (const l of labels) expect(l).toEqual(labels[0]);
  }

  // Arm + start room 0 and post: every member sees it, nobody else does.
  const first = rooms[0];
  if (first === undefined) throw new Error("room 0 missing");
  await armLobby(first.room, first.socks, { mode: "live", seed: 5 });
  first.socks[0]?.sendCmd(first.room.roomId, "st-0", "startGame", {});
  await Promise.all(first.socks.map((s) => s.next(isType("phaseChanged"))));
  const poster = first.socks[1];
  if (poster === undefined) throw new Error("poster missing");
  poster.sendCmd(first.room.roomId, "p-0", "submitText", { text: "よるのおやつ" });
  await poster.next(isAck("p-0"));
  for (const s of first.socks) {
    const e = await s.next(posted);
    if (e.type !== "inputAccepted") throw new Error("wrong frame");
    expect(e.payload.post?.text).toBe("よるのおやつ");
  }
  const other = rooms[1]?.socks[0];
  expect(other?.count(posted)).toBe(0);
  for (const { socks } of rooms) for (const s of socks) s.close();
}, 90_000);

test("restart: an alarm mid-game keeps the snapshot and deadlines intact", async () => {
  const { room, socks } = await sixUp();
  const host = socks[0];
  if (host === undefined) throw new Error("host missing");
  await armLobby(room, socks, { mode: "live", seed: 11 });
  host.sendCmd(room.roomId, "st-r", "startGame", {});
  await host.next(isAck("st-r"));
  host.sendCmd(room.roomId, "p-r", "submitText", { text: "かおす" });
  await host.next(isAck("p-r"));

  const stub = roomStubOf(room.roomId);
  const before = await stub.snapshot();
  const deadlinesBefore = (await deadlineRows(stub)).length;
  await deliverAlarm(stub);
  const after = await stub.snapshot();
  expect(after.stateRevision).toBe(before.stateRevision);
  expect(after.inputSeq).toBe(before.inputSeq);
  expect(after.phase).toBe(before.phase);
  expect((await deadlineRows(stub)).length).toBeGreaterThanOrEqual(deadlinesBefore);
  for (const s of socks) s.close();
});

test("abuse: full room, bad invite, bad reconnect and a ghost apply refuse", async () => {
  const { room, socks } = await sixUp();
  const host = socks[0];
  if (host === undefined) throw new Error("host missing");
  // Seventh seat refuses at the API with room-full.
  const seventh = await postJson(`/api/rooms/${room.roomId}/join`, {
    inviteSecret: room.inviteSecret,
  });
  expect(seventh.status).toBe(403);
  expect(((await seventh.json()) as { error: string }).error).toBe("room-full");

  const small = await createRoom();
  const badInvite = await postJson(`/api/rooms/${small.roomId}/join`, {
    inviteSecret: "deadbeef",
  });
  expect(badInvite.status).toBe(403);
  expect(((await badInvite.json()) as { error: string }).error).toBe("bad-invite");

  const badRecon = await postJson(`/api/rooms/${room.roomId}/reconnect`, {
    reconnectToken: "not-a-token",
  });
  expect(badRecon.status).toBe(403);
  expect(((await badRecon.json()) as { error: string }).error).toBe("bad-reconnect");

  // A forged apply from a playerId the room never seated is rejected at
  // the DO — no command row, no event row, no state move.
  await armLobby(room, socks, { mode: "live", seed: 3 });
  host.sendCmd(room.roomId, "st-a", "startGame", {});
  await host.next(isAck("st-a"));
  const stub = roomStubOf(room.roomId);
  const before = await stub.snapshot();
  await expect(
    stub.apply({
      playerId: "ghost",
      commandId: "ghost-1",
      fingerprint: "ghost-fp",
      action: { type: "post", playerId: "ghost", text: "ghost", nowMs: Date.now() },
    }),
  ).rejects.toThrow();
  const after = await stub.snapshot();
  expect(after.stateRevision).toBe(before.stateRevision);
  for (const s of socks) s.close();
});

test("close: every entrypoint refuses and the wipe leaves only a tombstone", async () => {
  const { room, joins, socks } = await sixUp();
  const host = socks[0];
  if (host === undefined) throw new Error("host missing");
  host.sendCmd(room.roomId, "c", "closeRoom");
  await host.next(isAck("c"));
  for (const s of socks) {
    const info = await s.waitClose();
    expect(info.code).toBe(1000);
  }

  const dead = async (path: string, body: unknown) => (await postJson(path, body)).status;
  expect(await dead(`/api/rooms/${room.roomId}/join`, { inviteSecret: room.inviteSecret })).toBe(
    410,
  );
  expect(
    await dead(`/api/rooms/${room.roomId}/reconnect`, { reconnectToken: joins[0]?.reconnectToken }),
  ).toBe(410);
  expect(
    await dead(`/api/rooms/${room.roomId}/ticket`, { sessionToken: joins[0]?.sessionToken }),
  ).toBe(410);
  const up = await SELF.fetch(`https://ws.test/api/rooms/${room.roomId}/ws?ticket=anything`, {
    headers: { upgrade: "websocket", origin: "http://localhost:5173" },
  });
  expect(up.status).not.toBe(101);
  await assertWiped(roomStubOf(room.roomId));
});
