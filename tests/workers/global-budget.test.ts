// Task 22 global-budget happy-path tests. Every run goes through the real
// GameRoom/ControlPlane DOs (same isolate, real SQLite); only the upstream
// Jev fetch is stubbed, and each test pins a UNIQUE UTC day via the
// injected nowMs so budget_days rows never bleed between tests.
//
// The suite default (decision-deps-setup.ts) injects a fail-closed budget;
// these tests re-inject a real ControlPlane per case via budget-helpers.
import { afterEach, beforeEach, expect, test } from "vitest";
import { utcDay } from "../../apps/server/src/control/budgets";
import { JEV_ORDINARY_CAP, JEV_PER_GAME_CAP } from "../../apps/server/src/rooms/decision-jobs";
import { eventRows, must } from "./room-helpers";
import {
  drive,
  injectDeps,
  jevLedger,
  liveRoom,
  NOW,
  okUpstream,
  post,
  restoreDefaultDeps,
  type RoomStub,
  testState,
  type Upstream,
  useDay,
} from "./budget-helpers";

// Unique UTC day per test so budget ledger assertions are isolated.
let upstreamBag: Upstream[] = [];
const sentTotal = () => upstreamBag.reduce((a, u) => a + u.sent, 0);

beforeEach(() => {
  // Default: real ControlPlane (env binding — resolved inside each room's
  // own I/O context; an injected stub object would cross DO contexts and
  // workerd rejects the I/O) + counting upstream. nowMs is pinned per test.
  const upstream: Upstream = { sent: 0 };
  injectDeps({ fetch: okUpstream(upstream) });
  upstreamBag.push(upstream);
});

afterEach(() => {
  upstreamBag = [];
  restoreDefaultDeps();
});

test("happy: ten rooms run decision jobs against one daily budget", async () => {
  testState.dayMs = useDay("2026-09-22");
  const day = utcDay(testState.dayMs);
  const ROOMS = 10;
  const stubs: RoomStub[] = [];
  for (let i = 0; i < ROOMS; i += 1) stubs.push(await liveRoom(`ten-${i}`));
  // Ten rooms post in parallel — every room takes its own reservation.
  await Promise.all(stubs.map((stub, i) => post(stub, "p1", 0, NOW + 1000 + i)));
  await Promise.all(stubs.map((stub) => drive(stub)));

  const snaps = await Promise.all(stubs.map((stub) => stub.snapshot()));
  for (const snap of snaps) {
    expect(snap.state.posts).toHaveLength(1);
    expect(snap.state.posts[0]?.status).toBe("evaluated");
    expect(snap.quota.jevAttempts).toBe(1);
  }
  // Total upstream sends equal consumed reservations; never above the cap.
  const ledger = await jevLedger(day);
  expect(sentTotal()).toBe(ROOMS);
  expect(ledger.reserved).toBe(ROOMS);
  expect(ledger.consumed).toBe(ROOMS);
  expect(ledger.consumed).toBeLessThanOrEqual(must(ledger.cap, "cap"));

  // A decisionUpdated row was persisted per evaluated post.
  const rows = await eventRows(must(stubs[0], "room 0"));
  const decision = rows.find((r) => r.type === "decisionUpdated");
  expect(decision).toBeDefined();
  expect(JSON.parse(must(decision, "decision row").payload)).toMatchObject({
    postId: "p1",
  });
});

test("happy: 118 ordinary attempts, final two settle-only, no 121st", async () => {
  testState.dayMs = useDay("2026-09-23");
  const day = utcDay(testState.dayMs);
  const room = await liveRoom("pergame");
  // 118 ordinary posts, alternating so each player's pending slot is free.
  for (let i = 0; i < JEV_ORDINARY_CAP; i += 1) {
    await post(room, i % 2 === 0 ? "p1" : "p2", i, NOW + 1000 + i * 100);
    await drive(room);
  }
  let snap = await room.snapshot();
  expect(snap.quota.jevAttempts).toBe(JEV_ORDINARY_CAP);
  expect(sentTotal()).toBe(JEV_ORDINARY_CAP);
  expect(snap.state.posts.every((p) => p.status === "evaluated")).toBe(true);

  // Ordinary posts 119+120 are accepted as input but their evaluations are
  // denied — the last two slots belong to settlement evaluations only.
  await post(room, "p1", 118, NOW + 1000 + 118 * 100);
  await post(room, "p2", 119, NOW + 1000 + 119 * 100);
  await drive(room);
  snap = await room.snapshot();
  expect(snap.quota.jevAttempts).toBe(JEV_ORDINARY_CAP);
  expect(snap.state.posts[118]?.status).toBe("pending");
  expect(snap.state.posts[119]?.status).toBe("pending");
  expect(sentTotal()).toBe(JEV_ORDINARY_CAP);

  // Host closes gameplay: the two pending posts now claim the final slots.
  await room.apply({
    playerId: "p1",
    commandId: "end-1",
    fingerprint: "fp-end-1",
    action: { type: "request-end", playerId: "p1", nowMs: NOW + 13000 },
  });
  await drive(room);
  snap = await room.snapshot();
  expect(snap.quota.jevAttempts).toBe(JEV_PER_GAME_CAP);
  expect(snap.state.posts[118]?.status).toBe("evaluated");
  expect(snap.state.posts[119]?.status).toBe("evaluated");
  expect(sentTotal()).toBe(JEV_PER_GAME_CAP); // 120 sent, no 121st
  // Fully evaluated cutoff -> the runner settled the game itself.
  expect(snap.phase).toBe("finished");
  expect(snap.state.outcome).toEqual({
    kind: "winner",
    playerId: snap.state.roster[0]?.id,
    slot: 0,
  });
  const ledger = await jevLedger(day);
  expect(ledger.reserved).toBe(JEV_PER_GAME_CAP);
  expect(ledger.consumed).toBe(JEV_PER_GAME_CAP);
});

test("happy: generation slots allow exactly one pre and one post", async () => {
  testState.dayMs = useDay("2026-09-24");
  const room = await liveRoom("genslots");
  expect(await room.tryGenerationSlot("pre")).toBe(true);
  expect(await room.tryGenerationSlot("pre")).toBe(false);
  expect(await room.tryGenerationSlot("post")).toBe(true);
  expect(await room.tryGenerationSlot("post")).toBe(false);
  expect(await room.tryGenerationSlot("bogus")).toBe(false);
  const snap = await room.snapshot();
  expect(snap.quota.generationAttempts).toBe(2);
});

test("happy: UTC day rollover starts a fresh budget bucket", async () => {
  testState.dayMs = useDay("2026-09-25");
  const dayA = utcDay(testState.dayMs);
  const room = await liveRoom("rollover");
  await post(room, "p1", 0, NOW + 1000);
  await drive(room);
  const ledgerA = await jevLedger(dayA);
  expect(ledgerA.reserved).toBe(1);
  expect(ledgerA.consumed).toBe(1);

  // Same room, next UTC day: a fresh bucket — yesterday's reservation is
  // not counted again.
  testState.dayMs = useDay("2026-09-26");
  const dayB = utcDay(testState.dayMs);
  await post(room, "p2", 1, NOW + 2000);
  await drive(room);
  const ledgerB = await jevLedger(dayB);
  expect(ledgerB.reserved).toBe(1);
  expect(ledgerB.consumed).toBe(1);
  const ledgerA2 = await jevLedger(dayA);
  expect(ledgerA2.reserved).toBe(1); // unchanged — no double count
  expect(ledgerA2.consumed).toBe(1);
  expect(sentTotal()).toBe(2);
});
