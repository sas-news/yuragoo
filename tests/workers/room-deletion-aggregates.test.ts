// Task 21: the anonymous aggregate outbox. Every submission is numbers
// only with a random receipt; ControlPlane dedupes inside 24h and refuses
// stale receipts, public stats stay "pending" under 20 completed games
// and only ever publish prior UTC-day buckets. The outbox retries at most
// five minutes while the room lives and dies with it — close wins races.
import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { injectOutboxDeps, type AggregateSink } from "../../apps/server/src/rooms/aggregate-outbox";
import { utcDay } from "../../apps/server/src/control/budgets";
import { injectCloseHooksForTest } from "../../apps/server/src/rooms/close";
import { deliverAlarm, execSql, namedRoom, NOW } from "./room-helpers";
import {
  controlStub,
  injectDeps,
  LIVE,
  liveRoom,
  okUpstream,
  poll,
  restoreDefaultDeps,
  testState,
  useDay,
  type Upstream,
} from "./budget-helpers";
import { BASE, GOOD_ORIGIN } from "./ws-helpers";
import { assertWiped, finishWinner } from "./room-deletion-helpers";

afterEach(() => {
  restoreDefaultDeps();
  injectOutboxDeps(null);
  injectCloseHooksForTest(null);
});

test("happy: two completed games submit aggregates once each; public stats publish at 20", async () => {
  testState.dayMs = useDay("2027-03-14");
  const upstream: Upstream = { sent: 0 };
  injectDeps({ fetch: okUpstream(upstream) });
  // The deterministic game clock (NOW) is ahead of the wall clock — pin
  // the outbox clock so pending submissions are due immediately. The sink
  // stays the real ControlPlane binding.
  const clock = { now: NOW + 10_000 };
  injectOutboxDeps({ nowMs: () => clock.now });

  const before = await controlStub().aggregateTotals();
  const a = await liveRoom("agg-a");
  const b = await liveRoom("agg-b");
  await finishWinner(a, "a");
  await finishWinner(b, "b");

  // Each finished game submitted exactly one numbers-only delta.
  expect(
    await poll(
      async () =>
        (await controlStub().aggregateTotals()).completedGames === before.completedGames + 2,
    ),
  ).toBe(true);
  const totals = await controlStub().aggregateTotals();
  expect(totals.completedGames - before.completedGames).toBe(2);
  expect(totals.totalMessages - before.totalMessages).toBe(2);
  expect(totals.totalDurationMs - before.totalDurationMs).toBe(8_000);

  // Delivered rows leave the outbox — nothing pending, nothing duplicated.
  for (const stub of [a, b]) {
    expect((await execSql(stub, "SELECT COUNT(*) AS n FROM outbox"))[0]?.n).toBe(0);
  }

  // The public view counts only UTC days strictly before the probe day.
  // The room games landed on utcDay(clock.now); probe at that day's start
  // so they (and the dedupe replay below) stay out of the public window.
  const boundaryMs = Date.parse(`${utcDay(clock.now)}T00:00:00Z`);
  expect(await controlStub().publicStats({ nowMs: boundaryMs })).toEqual({
    status: "pending",
  });

  // The same receiptId inside 24h counts once, never twice.
  const replay = {
    receiptId: "replay-one",
    completedGames: 1,
    totalMessages: 1,
    totalDurationMs: 5,
    nowMs: clock.now,
  };
  expect(await controlStub().submitAggregate(replay)).toEqual({ ok: true, dedupe: false });
  expect(await controlStub().submitAggregate(replay)).toEqual({ ok: true, dedupe: true });
  expect((await controlStub().aggregateTotals()).completedGames).toBe(totals.completedGames + 1);

  // Twenty completed games on the UTC day before the boundary publish the
  // totals — days on/after the boundary (room games, replay) stay hidden.
  const dayMs = boundaryMs - 12 * 60 * 60 * 1000;
  for (let i = 0; i < 20; i += 1) {
    const res = await controlStub().submitAggregate({
      receiptId: `pub-${i}`,
      completedGames: 1,
      totalMessages: 3,
      totalDurationMs: 100,
      nowMs: dayMs,
    });
    expect(res.ok).toBe(true);
  }
  expect(await controlStub().publicStats({ nowMs: boundaryMs })).toEqual({
    status: "ok",
    completedGames: 20,
    totalMessages: 60,
    totalDurationMs: 2_000,
    averageDurationMs: 100,
  });

  // GET /api/stats serves the same numbers-only public shape — pending or
  // ok is contract-valid here (the wall clock decides the day boundary),
  // but the payload must never carry identifiers or content.
  const res = await SELF.fetch(`${BASE}/api/stats`, { headers: { origin: GOOD_ORIGIN } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.status === "pending" || body.status === "ok").toBe(true);
  expect(JSON.stringify(body)).not.toMatch(/roomId|playerId|receipt|displayName|post|text/i);
});

test("happy: a pending outbox row is discarded at close — no late ControlPlane call", async () => {
  testState.dayMs = useDay("2027-03-15");
  const upstream: Upstream = { sent: 0 };
  injectDeps({ fetch: okUpstream(upstream) });
  let calls = 0;
  const clock = { now: NOW + 10_000 };
  injectOutboxDeps({
    nowMs: () => clock.now,
    control: {
      submitAggregate: async () => {
        calls += 1;
        throw new Error("control-plane-down");
      },
    } satisfies AggregateSink,
  });

  const { stub } = namedRoom("outbox-close");
  await stub.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: NOW });
  await finishWinner(stub, "x");

  // The submission was attempted and refused to land — the row stays.
  expect(await poll(async () => calls >= 1)).toBe(true);
  expect((await execSql(stub, "SELECT COUNT(*) AS n FROM outbox"))[0]?.n).toBe(1);

  await stub.retireRoom();
  await assertWiped(stub);

  // No late submission can happen after deletion: the row died with the
  // room and a closed room's outbox drive is a no-op.
  const before = calls;
  await deliverAlarm(stub);
  await runInDurableObject(stub, (i) => i.driveOutbox());
  clock.now += 60_000;
  await runInDurableObject(stub, (i) => i.driveOutbox());
  expect(calls).toBe(before);
});

test("failure: a receipt resent after 24h is refused and never recounts", async () => {
  const t = Date.parse("2027-02-10T00:00:00Z");
  const before = await controlStub().aggregateTotals();
  const input = {
    receiptId: "receipt-24h",
    completedGames: 1,
    totalMessages: 7,
    totalDurationMs: 900,
  };
  expect(await controlStub().submitAggregate({ ...input, nowMs: t })).toEqual({
    ok: true,
    dedupe: false,
  });
  // Within the window the same receipt is an idempotent replay.
  expect(await controlStub().submitAggregate({ ...input, nowMs: t + 60_000 })).toEqual({
    ok: true,
    dedupe: true,
  });
  // Past the window it is refused outright — it can never recount.
  expect(await controlStub().submitAggregate({ ...input, nowMs: t + 25 * 60 * 60 * 1000 })).toEqual(
    { ok: false, reason: "stale-receipt" },
  );
  const totals = await controlStub().aggregateTotals();
  expect(totals.completedGames - before.completedGames).toBe(1);
  expect(totals.totalMessages - before.totalMessages).toBe(7);
});

test("failure: ControlPlane failure retries the outbox inside its window then drops; close still deletes", async () => {
  testState.dayMs = useDay("2027-03-16");
  const upstream: Upstream = { sent: 0 };
  injectDeps({ fetch: okUpstream(upstream) });
  let calls = 0;
  // The outbox clock matches the game clock so the retry window is exact.
  const clock = { now: NOW + 10_000 };
  injectOutboxDeps({
    nowMs: () => clock.now,
    control: {
      submitAggregate: async () => {
        calls += 1;
        throw new Error("control-plane-down");
      },
    } satisfies AggregateSink,
  });

  const { stub } = namedRoom("outbox-window");
  await stub.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: NOW });
  await finishWinner(stub, "y");

  // First attempt failed inside the window — the row is rescheduled.
  expect(await poll(async () => calls >= 1)).toBe(true);
  expect((await execSql(stub, "SELECT COUNT(*) AS n FROM outbox"))[0]?.n).toBe(1);

  // Past the 5-minute window the row is dropped instead of retried.
  clock.now = NOW + 4_000 + 6 * 60 * 1000;
  await runInDurableObject(stub, (i) => i.driveOutbox());
  expect((await execSql(stub, "SELECT COUNT(*) AS n FROM outbox"))[0]?.n).toBe(0);
  expect(calls).toBeGreaterThanOrEqual(2);

  // A close on top of a dead ControlPlane still completes and deletes.
  await stub.retireRoom();
  await assertWiped(stub);
});
