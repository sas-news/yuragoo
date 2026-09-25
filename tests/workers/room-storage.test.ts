// GameRoom DO persistence tests against real SQLite inside workerd via the
// actual GAME_ROOM binding. Each test claims a unique room id — durable
// object storage persists for the whole miniflare run.
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { ApplyInput } from "../../apps/server/src/rooms/GameRoom";
import { loadRoom } from "../../apps/server/src/rooms/recovery";
import { ensureSchema } from "../../apps/server/src/rooms/schema";
import {
  commandRow,
  deliverAlarm,
  eventRows,
  execSql,
  LIVE_SETTINGS,
  must,
  namedRoom,
  NOW,
  readAlarm,
  roomStub,
  setAlarm,
  TURN_SETTINGS,
} from "./room-helpers";
import { drive } from "./budget-helpers";

const post = (playerId: string, text: string, nowMs: number): ApplyInput["action"] => ({
  type: "post",
  playerId,
  text,
  nowMs,
});

test("happy: committed state recovers identically after eviction", async () => {
  // Given a created TURN room with one accepted post
  const room = roomStub("recover");
  await room.createRoom({ settings: TURN_SETTINGS, playerIds: ["p1", "p2"], nowMs: NOW });
  const poster = must((await room.snapshot()).state.turnOrder[0], "turn player");
  const applied = await room.apply({
    playerId: poster,
    commandId: "c1",
    fingerprint: "fp-1",
    action: post(poster, "hello", NOW + 1000),
  });
  expect(applied.ack.accepted).toBe(true);
  // The post's evaluate job dies fail-closed (suite deps: no ControlPlane)
  // — drive it explicitly so the decisionFailed row lands deterministically.
  await drive(room);

  // When the ledger is read back it reflects the commit exactly
  const snap = await room.snapshot();
  expect(snap.gameEpoch).toBe(1);
  expect(snap.inputSeq).toBe(1);
  expect(snap.stateRevision).toBe(5); // started, turn, posted, next turn, decisionFailed
  expect(snap.deadlines).toEqual([{ id: "turn", runAt: NOW + 21_000, tag: "turn" }]);
  expect(snap.quota).toEqual({ jevAttempts: 0, generationAttempts: 0 });

  // Then the pure recovery read sees the identical persisted state
  const loaded = await runInDurableObject(room, (_i, ctx) => loadRoom(ctx.storage));
  if (loaded.kind !== "ready") throw new Error(`recovery failed: ${loaded.kind}`);
  expect(loaded.room.meta.inputSeq).toBe(1);
  expect(loaded.room.meta.stateRevision).toBe(5);
  expect(loaded.room.state).toEqual(snap.state);

  // And an evicted, rebuilt instance serves the same snapshot
  await evictDurableObject(room);
  const rebuilt = await room.snapshot();
  expect(rebuilt.inputSeq).toBe(1);
  expect(rebuilt.state).toEqual(snap.state);
  expect(rebuilt.deadlines).toEqual(snap.deadlines);
});

test("happy: dedupe replays the stored ack and rejects a changed payload", async () => {
  // Given a LIVE room with one accepted post under command cmd-9
  const room = roomStub("dedupe");
  await room.createRoom({ settings: LIVE_SETTINGS, playerIds: ["p1", "p2"], nowMs: NOW });
  const input: ApplyInput = {
    playerId: "p1",
    commandId: "cmd-9",
    fingerprint: "fp-a",
    action: post("p1", "hi", NOW + 1),
  };
  const first = await room.apply(input);
  // The post's evaluate job dies fail-closed — drive it so the
  // decisionFailed row is committed before the assertions below.
  await drive(room);

  // When the same command is delivered again, the stored ack comes back
  const replay = await room.apply(input);
  expect(replay).toEqual(first);
  // and no second transition was committed: started + posted + the
  // failed-eval row
  expect(await eventRows(room)).toHaveLength(3);
  expect((await room.snapshot()).inputSeq).toBe(1);

  // A different payload under the same commandId is a conflict
  await expect(room.apply({ ...input, fingerprint: "fp-b" })).rejects.toThrow(
    /idempotency-conflict/,
  );
});

test("happy: a duplicated due-alarm delivery finishes the game once", async () => {
  // Given a LIVE room whose match deadline is already in the past
  const room = roomStub("alarm");
  await room.createRoom({
    // devMode keeps the pre-Task-26 one-second clocks valid for the alarm test.
    settings: {
      mode: "live",
      seed: 3,
      rosterSize: 2,
      liveSeconds: 1,
      settleSeconds: 1,
      devMode: true,
    },
    playerIds: ["p1", "p2"],
    nowMs: Date.now() - 5_000,
  });

  // When the alarm is delivered, the deadline action runs once. workerd may
  // also deliver the past-due alarm on its own — the handler is idempotent,
  // so a direct instance delivery is the deterministic check.
  await deliverAlarm(room);
  expect((await room.snapshot()).state.phase).toBe("complete");

  // When the one-second settle window has expired and the due alarm is
  // delivered, the settle-deadline action fixes the outcome exactly once
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await deliverAlarm(room);
  const finished = await room.snapshot();
  expect(finished.state.phase).toBe("finished");
  expect(finished.state.outcome).toEqual({ kind: "noContest", reason: "timeout" });
  const eventsAfterFinish = await eventRows(room);

  // the duplicate delivery is a no-op: phase and events are unchanged
  await deliverAlarm(room);
  expect((await room.snapshot()).state.phase).toBe("finished");
  expect(await eventRows(room)).toEqual(eventsAfterFinish);
});

test("failure: a mid-transaction error rolls back dedupe, event and snapshot", async () => {
  // Given a LIVE room with one committed post
  const room = roomStub("poison");
  await room.createRoom({ settings: LIVE_SETTINGS, playerIds: ["p1", "p2"], nowMs: NOW });
  await room.apply({
    playerId: "p1",
    commandId: "c1",
    fingerprint: "fp-1",
    action: post("p1", "hi", NOW + 1),
  });
  // Drain the fail-closed eval job first — its decisionFailed row must land
  // before the revision snapshot or the poison insert races it.
  await drive(room);
  const rev = (await room.snapshot()).stateRevision;
  const alarmBefore = await readAlarm(room);

  // When an events row is poisoned at the next revision, the commit fails midway
  await execSql(
    room,
    "INSERT INTO events (seq, type, payload) VALUES (?, ?, ?)",
    rev + 1,
    "poison",
    "{}",
  );
  const eventsBefore = await eventRows(room);
  await expect(
    room.apply({
      playerId: "p2",
      commandId: "c2",
      fingerprint: "fp-2",
      action: post("p2", "again", NOW + 2),
    }),
  ).rejects.toThrow();

  // Then nothing from the aborted commit survives: no dedupe row, no new
  // event, the snapshot is unchanged and the alarm was never touched
  expect(await commandRow(room, "p2", "c2")).toBeNull();
  expect(await eventRows(room)).toEqual(eventsBefore);
  const snap = await room.snapshot();
  expect(snap.inputSeq).toBe(1);
  expect(snap.stateRevision).toBe(rev);
  expect(await readAlarm(room)).toBe(alarmBefore);
});

test("failure: the constructor never overwrites an existing alarm", async () => {
  // Given a created room whose single alarm is armed at the match deadline
  const { stub: room, id } = namedRoom("keep-alarm");
  await room.createRoom({ settings: LIVE_SETTINGS, playerIds: ["p1", "p2"], nowMs: NOW });
  expect(await readAlarm(room)).toBe(NOW + 120_000);

  // When the alarm is moved far out and the object is evicted and rebuilt
  const future = NOW + 999_000_000;
  await setAlarm(room, future);
  await evictDurableObject(room);
  const rebuilt = env.GAME_ROOM.get(id);

  // Then recovery left the existing alarm untouched
  expect(await readAlarm(rebuilt)).toBe(future);
});

test("failure: an unknown schema version fails closed on every entrypoint", async () => {
  // Given a room_meta row written by a newer schema before any room exists
  const { stub: seed, id } = namedRoom("bad-schema");
  await execSql(
    seed,
    "INSERT INTO room_meta (id, schema_version, game_epoch, input_seq, " +
      "state_revision, phase, snapshot, settings, jev_attempts, " +
      "generation_attempts, created_at_ms) VALUES (1, 99, 1, 0, 0, 'playing', '{}', '{}', 0, 0, 0)",
  );

  // When the object is evicted and rebuilt, recovery refuses the room
  await evictDurableObject(seed);
  const room = env.GAME_ROOM.get(id);
  await expect(room.snapshot()).rejects.toThrow(/room-closed/);
  await expect(
    room.createRoom({ settings: LIVE_SETTINGS, playerIds: ["a1", "b2"], nowMs: NOW }),
  ).rejects.toThrow(/room-closed/);
  await expect(
    room.apply({
      playerId: "a1",
      commandId: "c1",
      fingerprint: "f",
      action: post("a1", "x", NOW + 1),
    }),
  ).rejects.toThrow(/room-closed/);
});

test("happy: re-running the same-version migration is a no-op", async () => {
  // Given a freshly constructed (already migrated) store
  const room = roomStub("migrate");
  // When ensureSchema runs twice at the same version nothing changes
  await runInDurableObject(room, (_i, ctx) => {
    ensureSchema(ctx.storage.sql);
    ensureSchema(ctx.storage.sql);
  });
  expect(await execSql(room, "SELECT COUNT(*) AS n FROM room_meta")).toEqual([{ n: 0 }]);
  // and the virgin store can still be claimed by createRoom
  await room.createRoom({ settings: LIVE_SETTINGS, playerIds: ["m1", "m2"], nowMs: NOW });
  expect((await room.snapshot()).gameEpoch).toBe(1);
});
