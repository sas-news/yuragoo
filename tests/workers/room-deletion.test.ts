// Task 21: room close + full physical deletion. The close sequence (revoke
// the ControlPlane mapping -> invalidate the room epoch -> close sockets ->
// deleteAll) is asserted end-to-end, including the failure paths: a failed
// wipe stays closed and retries, empty-grace expiry purges physically, and
// late callbacks can never resurrect a tombstoned room.
import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { injectCloseHooksForTest } from "../../apps/server/src/rooms/close";
import { injectRoomLimitsForTest } from "../../apps/server/src/rooms/limits";
import { deadlineRows, deliverAlarm, execSql, namedRoom, NOW } from "./room-helpers";
import { controlStub, LIVE, poll, post, restoreDefaultDeps } from "./budget-helpers";
import { armLobby, BASE, GOOD_ORIGIN, setupRoom, Sock, type Joined } from "./ws-helpers";
import { assertWiped, postJson, roomStubOf, tombstoneState } from "./room-deletion-helpers";

afterEach(() => {
  restoreDefaultDeps();
  injectRoomLimitsForTest(null);
  injectCloseHooksForTest(null);
});

test("happy: closeRoom revokes the mapping, closes sockets and deletes every row", async () => {
  const { room, joins } = await setupRoom(2);
  const stub = roomStubOf(room.roomId);
  const host = await Sock.connect(room.roomId, (joins[0] as Joined).sessionToken);
  const guest = await Sock.connect(room.roomId, (joins[1] as Joined).sessionToken);

  // Seed the ControlPlane mapping the close must revoke (the startGame
  // path also registers asynchronously — seeding keeps the assert exact).
  await controlStub().registerRoom({ roomId: room.roomId, nowMs: Date.now() });

  await armLobby(room, [host, guest], { mode: "live", seed: 9, liveSeconds: 120 });
  host.sendCmd(room.roomId, "c-start", "startGame", {});
  await host.next((e) => e.type === "ack" && e.payload.commandId === "c-start");

  // A single-use ticket issued before the close must be dead afterwards.
  const ticketRes = await postJson(`/api/rooms/${room.roomId}/ticket`, {
    sessionToken: (joins[1] as Joined).sessionToken,
  });
  const { ticket } = (await ticketRes.json()) as { ticket: string };

  host.sendCmd(room.roomId, "c-close", "closeRoom");
  await host.next((e) => e.type === "ack" && e.payload.commandId === "c-close");
  await guest.next((e) => e.type === "roomClosed");
  for (const s of [host, guest]) {
    const info = await s.waitClose();
    expect(info.code).toBe(1000);
    expect(info.reason).toBe("room-closed");
  }

  // Step 1 of the close: the ControlPlane mapping was revoked.
  expect(
    await poll(async () => (await controlStub().roomRegistration(room.roomId))?.revoked === true),
  ).toBe(true);

  // The wipe is complete: every data table is empty, tombstone says done.
  await assertWiped(stub);

  // Eviction cannot resurrect the room — the durable tombstone recovers
  // "closed" on the reconstructed instance. (evictDurableObject must come
  // BEFORE any rejecting RPC: a DO with a failed-RPC session cannot be
  // evicted under the test pool.)
  await evictDurableObject(stub);

  // Every HTTP entrypoint is dead: join, reconnect, ticket, ws upgrade —
  // all served by the reconstructed (tombstoned) instance.
  const joinRes = await postJson(`/api/rooms/${room.roomId}/join`, {
    inviteSecret: room.inviteSecret,
  });
  expect(joinRes.status).toBe(410);
  const reconRes = await postJson(`/api/rooms/${room.roomId}/reconnect`, {
    reconnectToken: (joins[0] as Joined).reconnectToken,
  });
  expect(reconRes.status).toBe(410);
  const ticketRes2 = await postJson(`/api/rooms/${room.roomId}/ticket`, {
    sessionToken: (joins[0] as Joined).sessionToken,
  });
  expect(ticketRes2.status).toBe(410);
  const wsRes = await SELF.fetch(`${BASE}/api/rooms/${room.roomId}/ws?ticket=${ticket}`, {
    headers: { upgrade: "websocket", origin: GOOD_ORIGIN },
  });
  expect(wsRes.status).toBe(410);

  // RPC entrypoints refuse too — snapshot, apply, createRoom.
  await expect(stub.snapshot()).rejects.toThrow(/room-closed/);
  await expect(
    stub.apply({
      playerId: "p1",
      commandId: "late-1",
      fingerprint: "fp-late",
      action: { type: "settle-deadline", nowMs: NOW },
    }),
  ).rejects.toThrow(/room-closed/);
  await expect(
    stub.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: NOW }),
  ).rejects.toThrow(/room-closed/);
  await assertWiped(stub);
});

test("failure: late AI/generation callbacks after close are refused and create nothing", async () => {
  // A second room covers the reconstructed-instance path: evict BEFORE
  // any rejecting call — a DO with a failed-RPC session cannot be evicted
  // under the test pool.
  const { stub: stub2 } = namedRoom("late-callbacks-2");
  await stub2.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: NOW });
  await stub2.retireRoom();
  await evictDurableObject(stub2);

  const { stub } = namedRoom("late-callbacks");
  await stub.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: NOW });
  await post(stub, "p1", 0, NOW + 1_000); // persists a pending ai_jobs row
  await stub.retireRoom();

  // Every entrypoint refuses on the dead epoch — nothing may write rows.
  await expect(stub.snapshot()).rejects.toThrow(/room-closed/);
  await expect(
    stub.apply({
      playerId: "p1",
      commandId: "late-post",
      fingerprint: "fp-late-post",
      action: { type: "post", playerId: "p1", text: "late", nowMs: NOW + 2_000 },
    }),
  ).rejects.toThrow(/room-closed/);
  await expect(stub.tryGenerationSlot("pre")).rejects.toThrow(/room-closed/);
  await expect(
    stub.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: NOW }),
  ).rejects.toThrow(/room-closed/);
  await expect(
    stub.initRoom({ inviteSecretHash: "h", platform: "browser", nowMs: NOW }),
  ).rejects.toThrow(/room-closed/);

  // The decision-job and outbox drives are no-ops on a closed room — a
  // late AI/settle callback resolves without writing anything.
  await runInDurableObject(stub, (i) => i.driveDecisionJobs());
  await runInDurableObject(stub, (i) => i.driveOutbox());
  await deliverAlarm(stub); // closed-room alarm only retries the wipe
  await assertWiped(stub);

  // The reconstructed room keeps the terminal state — the durable
  // tombstone means nothing can resurrect it.
  await expect(stub2.snapshot()).rejects.toThrow(/room-closed/);
  await runInDurableObject(stub2, (i) => i.driveDecisionJobs());
  await assertWiped(stub2);
});

test("failure: a failed deleteAll keeps the room closed and the retry completes it", async () => {
  let calls = 0;
  injectCloseHooksForTest({
    deleteAll: async (s) => {
      calls += 1;
      if (calls === 1) throw new Error("wipe-down");
      await s.deleteAll();
    },
  });
  const { stub } = namedRoom("wipe-fail");
  await stub.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: NOW });

  await stub.retireRoom();
  expect(calls).toBe(1);

  // The failed delete leaves the room closed and inaccessible — and the
  // tombstone records the pending wipe with a retry deadline armed.
  await expect(stub.snapshot()).rejects.toThrow(/room-closed/);
  await expect(
    stub.apply({
      playerId: "p1",
      commandId: "late",
      fingerprint: "fp",
      action: { type: "settle-deadline", nowMs: NOW },
    }),
  ).rejects.toThrow(/room-closed/);
  expect(await tombstoneState(stub)).toBe("pending");
  expect((await deadlineRows(stub)).some((d) => d.tag === "wipe-retry")).toBe(true);
  expect(await runInDurableObject(stub, (_i, ctx) => ctx.storage.getAlarm())).not.toBeNull();

  // The room alarm re-attempts the wipe and it succeeds this time.
  await deliverAlarm(stub);
  expect(calls).toBe(2);
  expect(await tombstoneState(stub)).toBe("done");
  await assertWiped(stub);
});

test("failure: the empty-grace expiry purges the room physically", async () => {
  const { room, joins } = await setupRoom(2);
  const stub = roomStubOf(room.roomId);
  const host = await Sock.connect(room.roomId, (joins[0] as Joined).sessionToken);
  const guest = await Sock.connect(room.roomId, (joins[1] as Joined).sessionToken);
  await armLobby(room, [host, guest], { mode: "live", seed: 5, liveSeconds: 120 });
  host.sendCmd(room.roomId, "e-start", "startGame", {});
  await host.next((e) => e.type === "ack" && e.payload.commandId === "e-start");

  // Everyone leaves; the empty-grace clock starts.
  host.close();
  guest.close();
  await poll(async () => {
    const p = await execSql(stub, "SELECT empty_since_ms AS e FROM room_presence WHERE id = 1");
    return p[0]?.e !== null && p[0]?.e !== undefined;
  });

  // Force the grace boundary: the expiry row fires, marks the room expired
  // and arms the purge deadline.
  await execSql(stub, "UPDATE room_presence SET empty_since_ms = empty_since_ms - 100000");
  await execSql(stub, "UPDATE deadlines SET run_at = run_at - 100000 WHERE id = 'room-expiry'");
  await deliverAlarm(stub);
  const presence = await execSql(stub, "SELECT expired AS e FROM room_presence WHERE id = 1");
  expect(presence[0]?.e).toBe(1);
  expect(
    await poll(async () => (await deadlineRows(stub)).some((d) => d.tag === "room-purge")),
  ).toBe(true);

  // The purge row now runs the real delete — physically, not just a flag.
  await execSql(stub, "UPDATE deadlines SET run_at = run_at - 100000 WHERE id = 'room-purge'");
  await deliverAlarm(stub);
  await assertWiped(stub);

  // The old invite/tokens are dead — the room refuses every entrypoint.
  const joinRes = await postJson(`/api/rooms/${room.roomId}/join`, {
    inviteSecret: room.inviteSecret,
  });
  expect(joinRes.status).toBe(410);
  await expect(stub.snapshot()).rejects.toThrow(/room-closed/);
});
