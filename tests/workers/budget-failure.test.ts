// Task 22 failure-path tests: orphaned jobs, denied budgets, retry bounds
// and the atomic multi-room reserve race — all through the real
// GameRoom/ControlPlane DOs with only the upstream fetch stubbed. Each
// test pins a UNIQUE UTC day via the injected nowMs.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { parseCap, utcDay } from "../../apps/server/src/control/budgets";
import { attemptToken } from "../../apps/server/src/rooms/ai-jobs";
import {
  forceJobStateForTest,
  type JobBudget,
  jobRowForTest,
  type UpstreamFetch,
} from "../../apps/server/src/rooms/decision-jobs";
import { deliverAlarm, must, namedRoom } from "./room-helpers";
import {
  controlStub,
  drive,
  injectDeps,
  jevLedger,
  LIVE,
  liveRoom,
  NOW,
  okUpstream,
  poll,
  post,
  restoreDefaultDeps,
  statusUpstream,
  testState,
  type Upstream,
  useDay,
} from "./budget-helpers";

beforeEach(() => {
  injectDeps({ fetch: okUpstream({ sent: 0 }) });
});

afterEach(() => {
  restoreDefaultDeps();
});

test("failure: a sent-then-lost job is suppressed and consumed, never resent", async () => {
  testState.dayMs = useDay("2026-09-27");
  const day = utcDay(testState.dayMs);
  const upstream: Upstream = { sent: 0 };
  // Post under a closed budget so the job dies fast, then forge the
  // "sent" row + matching reservation the crash would have left behind.
  injectDeps({ control: null, fetch: okUpstream(upstream) });
  const { stub: room, id } = namedRoom("crash");
  const roomId = id.toString();
  await room.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: NOW });
  await post(room, "p1", 0, NOW + 1000);
  await drive(room);
  const snap = await room.snapshot();
  const postId = must(snap.state.posts[0]?.postId, "postId");
  await runInDurableObject(room, (i) => forceJobStateForTest(i, postId, "sent", 1));
  const token = attemptToken(roomId, snap.gameEpoch, postId, 1);
  const grant = await controlStub().reserve({ roomId, token, kind: "jev", day });
  expect(grant.ok).toBe(true);

  // Simulate the isolate loss, then let the next contact rebuild the DO.
  injectDeps({ fetch: okUpstream(upstream) });
  await evictDurableObject(room);
  await room.snapshot(); // reconstruction runs the recovery pass
  const consumed = await poll(async () => (await jevLedger(day)).consumed === 1);
  expect(consumed).toBe(true);

  const job = await runInDurableObject(room, (i) => jobRowForTest(i, postId));
  expect(job?.state).toBe("failed");
  expect(upstream.sent).toBe(0); // the upstream call was never re-issued
  const snap2 = await room.snapshot();
  expect(snap2.state.posts[0]?.status).toBe("pending"); // settle can noContest it
});

test("failure: ControlPlane unavailable denies jobs without freezing the game", async () => {
  testState.dayMs = useDay("2026-09-28");
  const upstream: Upstream = { sent: 0 };
  injectDeps({ control: null, fetch: okUpstream(upstream) });
  // Near-real clock so the settle deadline can actually fire.
  const t0 = Date.now() - 60_000;
  const { stub: room } = namedRoom("down");
  await room.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: t0 });
  const p1 = await post(room, "p1", 0, t0 + 1000);
  expect(p1.ack.accepted).toBe(true);
  await drive(room);
  await post(room, "p2", 1, t0 + 2000);
  await drive(room);

  const snap = await room.snapshot();
  expect(snap.state.posts).toHaveLength(2);
  expect(snap.state.posts.every((p) => p.status === "pending")).toBe(true);
  expect(upstream.sent).toBe(0);
  const jobStates = await Promise.all(
    snap.state.posts.map((p) => runInDurableObject(room, (i) => jobRowForTest(i, p.postId))),
  );
  expect(jobStates.every((j) => j?.state === "failed")).toBe(true);

  // The game still settles on its own clock — timeout noContest. The
  // settle deadline is already past due; a manual alarm delivery fires it
  // (a real delivery racing in is a harmless duplicate).
  await room.apply({
    playerId: "p1",
    commandId: "end-1",
    fingerprint: "fp-end-1",
    action: { type: "request-end", playerId: "p1", nowMs: t0 + 3000 },
  });
  await deliverAlarm(room);
  const finished = await poll(async () => (await room.snapshot()).phase === "finished");
  expect(finished).toBe(true);
  const done = await room.snapshot();
  expect(done.state.outcome).toEqual({ kind: "noContest", reason: "timeout" });
});

test("failure: missing cap config denies jobs and surfaces an error", async () => {
  testState.dayMs = useDay("2026-09-29");
  // Pure side: an absent/malformed cap fails closed.
  expect(parseCap(undefined)).toBeNull();
  expect(parseCap("")).toBeNull();
  expect(parseCap("0")).toBeNull();
  expect(parseCap("abc")).toBeNull();
  expect(parseCap("64")).toBe(64);

  const upstream: Upstream = { sent: 0 };
  const denied: JobBudget = {
    reserve: async () => ({ ok: false }),
    consume: async () => ({ ok: true }),
    release: async () => ({ ok: true }),
  };
  injectDeps({ control: denied, fetch: okUpstream(upstream) });
  const room = await liveRoom("nocap");
  await post(room, "p1", 0, NOW + 1000);
  await drive(room);
  const snap = await room.snapshot();
  expect(snap.state.posts[0]?.status).toBe("pending");
  const job = await runInDurableObject(room, (i) =>
    jobRowForTest(i, must(snap.state.posts[0]?.postId, "postId")),
  );
  expect(job?.state).toBe("failed"); // denial is terminal, never retried
  expect(upstream.sent).toBe(0);
});

test("failure: long Retry-After bounds the retry; settle still resolves", async () => {
  testState.dayMs = useDay("2026-09-30");
  const upstream: Upstream = { sent: 0 };
  injectDeps({ fetch: statusUpstream(upstream, 429, "60") });
  const t0 = Date.now() - 60_000;
  const { stub: room } = namedRoom("retry429");
  await room.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: t0 });
  await post(room, "p1", 0, t0 + 1000);
  await drive(room);
  let snap = await room.snapshot();
  expect(upstream.sent).toBe(1); // 60s delay can never fit the job window
  expect(snap.quota.jevAttempts).toBe(1);
  expect(snap.state.posts[0]?.status).toBe("pending");

  await room.apply({
    playerId: "p1",
    commandId: "end-1",
    fingerprint: "fp-end-1",
    action: { type: "request-end", playerId: "p1", nowMs: t0 + 2000 },
  });
  await deliverAlarm(room);
  const finished = await poll(async () => (await room.snapshot()).phase === "finished");
  expect(finished).toBe(true);
  snap = await room.snapshot();
  expect(snap.state.outcome).toEqual({ kind: "noContest", reason: "timeout" });
});

test("failure: short Retry-After retries exactly once, then succeeds", async () => {
  testState.dayMs = useDay("2026-10-01");
  const day = utcDay(testState.dayMs);
  const upstream = { sent: 0 };
  const flaky: UpstreamFetch = async (input, init) => {
    if (upstream.sent === 0) {
      upstream.sent += 1;
      return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    }
    return okUpstream(upstream)(input, init);
  };
  // The shared counter: flaky increments itself for the first call, then
  // delegates (which increments again) — sent counts every wire attempt.
  injectDeps({ fetch: flaky });
  const room = await liveRoom("retry-ok");
  await post(room, "p1", 0, NOW + 1000);
  await drive(room);
  const snap = await room.snapshot();
  expect(upstream.sent).toBe(2); // try + exactly one retry
  expect(snap.state.posts[0]?.status).toBe("evaluated");
  const ledger = await jevLedger(day);
  expect(ledger.reserved).toBe(2); // each send took its own reservation
  expect(ledger.consumed).toBe(2);
});

test("failure: concurrent reserve calls grant exactly the daily cap", async () => {
  const day = "2026-10-02";
  const cap = 200; // JEV_DAILY_ATTEMPT_CAP test binding
  const RACES = 250;
  const control = controlStub();
  const results = await Promise.all(
    Array.from({ length: RACES }, (_v, i) =>
      control.reserve({ roomId: `race-${i % 5}`, token: `race-tok-${i}`, kind: "jev", day }),
    ),
  );
  const grantedIdx = results.findIndex((r) => r.ok);
  const granted = results.filter((r) => r.ok).length;
  expect(granted).toBe(cap);
  const ledger = await jevLedger(day);
  expect(ledger.reserved).toBe(cap);
  expect(ledger.consumed).toBe(0);
  // A granted reservation is idempotent-safe: replaying its token returns
  // the same grant instead of spending twice.
  const replay = await control.reserve({
    roomId: "race-0",
    token: `race-tok-${grantedIdx}`,
    kind: "jev",
    day,
  });
  expect(replay.ok).toBe(true);
});
