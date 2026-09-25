// Task 23: DO restart/recovery gate. evictDurableObject() stands in for
// the lost isolate; the fresh stub must continue the SAME game — epoch/
// seq/revision, dedupe, deadlines and interrupted ai_jobs all recover.
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { utcDay } from "../../apps/server/src/control/budgets";
import { attemptToken } from "../../apps/server/src/rooms/ai-jobs";
import { forceJobStateForTest, jobRowForTest } from "../../apps/server/src/rooms/decision-jobs";
import {
  deadlineRows,
  deliverAlarm,
  execSql,
  must,
  namedRoom,
  NOW,
  readAlarm,
  type RoomStub,
} from "./room-helpers";
import {
  controlStub,
  drive,
  injectDeps,
  jevLedger,
  LIVE,
  okUpstream,
  poll,
  post,
  restoreDefaultDeps,
  testState,
  type Upstream,
  useDay,
} from "./budget-helpers";

beforeEach(() => injectDeps({ fetch: okUpstream({ sent: 0 }) }));
afterEach(() => restoreDefaultDeps());

// A deadline row fires only when run_at is due and nowMs is past the
// state's own deadline — wait for the clock, then nudge.
const fireUntilPhase = async (
  stub: RoomStub,
  phase: string,
  atMs: number,
  timeoutMs = 15_000,
): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const s = await stub.snapshot();
    if (s.phase === phase) return;
    if (Date.now() >= atMs) await deliverAlarm(stub);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`phase ${phase} never arrived`);
};

test("happy: mid-playing restart keeps epoch/state/seq/dedupe and re-arms the deadline", async () => {
  testState.dayMs = useDay("2026-10-05");
  const upstream: Upstream = { sent: 0 };
  injectDeps({ fetch: okUpstream(upstream) });
  const t0 = Date.now(); // real clock — the fired action validates nowMs
  const { stub: room, id } = namedRoom("t23-mid");
  await room.createRoom({
    settings: { ...LIVE, liveSeconds: 8 },
    playerIds: ["p1", "p2"],
    nowMs: t0,
  });
  const first = await post(room, "p1", 0, t0 + 1_000);
  await post(room, "p2", 1, t0 + 2_000);
  await drive(room);
  const before = await room.snapshot();
  expect(before.phase).toBe("playing");
  expect(before.state.posts).toHaveLength(2);
  expect(before.state.posts.every((p) => p.status === "evaluated")).toBe(true);
  expect((await deadlineRows(room)).map((d) => d.id)).toContain("match");

  await evictDurableObject(room);
  const fresh = env.GAME_ROOM.get(id);
  const after = await fresh.snapshot();
  expect(after.gameEpoch).toBe(before.gameEpoch);
  expect(after.inputSeq).toBe(before.inputSeq);
  expect(after.stateRevision).toBe(before.stateRevision);
  expect(after.state).toEqual(before.state);

  // Dedupe survived: the same commandId replays its stored ack (the whole
  // ApplyResult round-trips), a different payload under it is a conflict.
  expect(await post(fresh, "p1", 0, t0 + 9_000)).toEqual(first);
  await expect(
    fresh.apply({
      playerId: "p1",
      commandId: "post-p1-0",
      fingerprint: "fp-other",
      action: { type: "post", playerId: "p1", text: "差し替え", nowMs: t0 + 9_001 },
    }),
  ).rejects.toThrow(/idempotency-conflict/);

  // The match deadline row survived and the room alarm is armed again —
  // the SAME game still flows into the settle window on its own clock.
  expect(await poll(async () => (await readAlarm(fresh)) !== null)).toBe(true);
  await fireUntilPhase(fresh, "complete", must(before.state.deadlineAtMs, "deadlineAtMs"));
  expect((await fresh.snapshot()).state.endCause).toBe("deadline");
});

test("failure: restart suppresses orphaned reserved/sent jobs and re-drives pending work", async () => {
  testState.dayMs = useDay("2026-10-06");
  const day = utcDay(testState.dayMs);
  const upstream: Upstream = { sent: 0 };
  // Phase A: control:null fails jobs closed instantly so each row can be
  // forged into the exact residue a mid-flight crash would leave behind.
  injectDeps({ control: null, fetch: okUpstream(upstream) });
  const { stub: room, id } = namedRoom("t23-jobs");
  const roomId = id.toString();
  await room.createRoom({
    settings: { ...LIVE, rosterSize: 3 },
    playerIds: ["p1", "p2", "p3"],
    nowMs: NOW,
  });
  await post(room, "p1", 0, NOW + 1_000);
  await post(room, "p2", 1, NOW + 2_000);
  await post(room, "p3", 2, NOW + 3_000);
  await drive(room);
  const snap = await room.snapshot();
  const postId1 = must(snap.state.posts[0]?.postId, "postId1");
  const postId2 = must(snap.state.posts[1]?.postId, "postId2");
  const postId3 = must(snap.state.posts[2]?.postId, "postId3");
  const epoch = snap.gameEpoch;
  await runInDurableObject(room, (i) => {
    forceJobStateForTest(i, postId1, "sent", 1); // durably sent, reply lost
    forceJobStateForTest(i, postId2, "reserved", 0); // grant held, never sent
    forceJobStateForTest(i, postId3, "pending", 0); // untouched survivor
  });
  // Matching ControlPlane grants the suppression pass must consume.
  for (const postId of [postId1, postId2]) {
    const grant = await controlStub().reserve({
      roomId,
      token: attemptToken(roomId, epoch, postId, 1),
      kind: "jev",
      day,
    });
    expect(grant.ok).toBe(true);
  }

  // Phase B: the real ControlPlane + stubbed upstream run the recovery.
  injectDeps({ fetch: okUpstream(upstream) });
  await evictDurableObject(room);
  const fresh = env.GAME_ROOM.get(id);
  await fresh.snapshot(); // construction suppresses orphans, redrives pending
  const done = await poll(
    async () =>
      (await runInDurableObject(fresh, (i) => jobRowForTest(i, postId3)))?.state === "done",
  );
  expect(done).toBe(true);
  const job1 = await runInDurableObject(fresh, (i) => jobRowForTest(i, postId1));
  const job2 = await runInDurableObject(fresh, (i) => jobRowForTest(i, postId2));
  expect(job1?.state).toBe("failed"); // orphaned attempts are suppressed
  expect(job2?.state).toBe("failed");
  expect(upstream.sent).toBe(1); // only the pending survivor re-sent
  const ledger = await jevLedger(day);
  expect(ledger.reserved).toBe(3); // 2 forged grants + 1 live send
  expect(ledger.consumed).toBe(3); // suppressed grants consumed, never leaked
  const after = await fresh.snapshot();
  expect(after.gameEpoch).toBe(epoch);
  const byId = new Map(after.state.posts.map((p) => [p.postId, p.status]));
  expect(byId.get(postId3)).toBe("evaluated");
  expect(byId.get(postId1)).toBe("pending"); // suppressed -> settle noContest
  expect(byId.get(postId2)).toBe("pending");
});

test("happy: a settling restart still enforces the hard 8s deadline — no fabricated winner", async () => {
  testState.dayMs = useDay("2026-10-07");
  const upstream: Upstream = { sent: 0 };
  // Jobs fail closed so the last-second post stays pending through settle.
  injectDeps({ control: null, fetch: okUpstream(upstream) });
  const t0 = Date.now(); // the settle clock validates against real nowMs
  const { stub: room, id } = namedRoom("t23-settle");
  await room.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: t0 });
  await post(room, "p1", 0, t0 + 1_000);
  await drive(room);
  await room.apply({
    playerId: "p1",
    commandId: "end-1",
    fingerprint: "fp-end-1",
    action: { type: "request-end", playerId: "p1", nowMs: t0 + 2_000 },
  });
  const complete = await room.snapshot();
  expect(complete.phase).toBe("complete");
  const settleAtMs = must(complete.state.settleDeadlineAtMs, "settleDeadlineAtMs");
  expect(settleAtMs).toBe(t0 + 2_000 + 8_000); // settleSeconds default = 8
  const settleRow = (await deadlineRows(room)).find((d) => d.tag === "settle");
  expect(settleRow?.runAt).toBe(settleAtMs);

  await evictDurableObject(room);
  const fresh = env.GAME_ROOM.get(id);
  const back = await fresh.snapshot();
  expect(back.phase).toBe("complete");
  expect(back.gameEpoch).toBe(complete.gameEpoch);
  expect(back.stateRevision).toBe(complete.stateRevision);
  expect(back.state.settleDeadlineAtMs).toBe(settleAtMs);

  // A host claim arriving after the hard deadline can never fabricate a
  // winner — the rule rejects it on the recovered instance too.
  await expect(
    fresh.apply({
      playerId: "p1",
      commandId: "late-claim",
      fingerprint: "fp-late",
      action: { type: "settle", nowMs: settleAtMs + 1, claim: { kind: "winner", slot: 0 } },
    }),
  ).rejects.toThrow(/after the settle deadline/);

  // The survived settle row fires on its own clock (real alarm delivery
  // or a manual duplicate — either way exactly one outcome lands).
  await fireUntilPhase(fresh, "finished", settleAtMs, 20_000);
  const fin = await fresh.snapshot();
  expect(fin.state.outcome).toEqual({ kind: "noContest", reason: "timeout" });
  // A late winner claim still cannot flip the finished outcome.
  await expect(
    fresh.apply({
      playerId: "p1",
      commandId: "post-deadline",
      fingerprint: "fp-pd",
      action: { type: "settle", nowMs: settleAtMs + 2_000, claim: { kind: "winner", slot: 0 } },
    }),
  ).rejects.toThrow(/requires the complete phase/);
});

test("failure: a reconstructed room never re-initializes wiped or closed storage", async () => {
  testState.dayMs = useDay("2026-10-08");
  // Empty storage must not invent a room (no meta row, no game).
  const { stub: empty } = namedRoom("t23-empty");
  await expect(empty.snapshot()).rejects.toThrow(/not-created/);
  expect((await execSql(empty, "SELECT COUNT(*) AS c FROM room_meta"))[0]?.c).toBe(0);

  // A tombstoned room: close -> evict -> still closed, never a fresh game.
  const { stub: room } = namedRoom("t23-closed");
  await room.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: NOW });
  await room.retireRoom();
  await evictDurableObject(room);
  await expect(room.snapshot()).rejects.toThrow(/room-closed/);
  await expect(
    room.apply({
      playerId: "p1",
      commandId: "late",
      fingerprint: "fp",
      action: { type: "abort" },
    }),
  ).rejects.toThrow(/room-closed/);
  await expect(
    room.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: NOW }),
  ).rejects.toThrow(/room-closed/);
});
