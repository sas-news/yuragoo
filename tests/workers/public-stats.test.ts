// Task 38: the public anonymous stats surface. The ControlPlane is the
// real DO; synthetic completions land through submitAggregate (the same
// numbers-only path the room outbox uses) and one real room game proves
// a closed/deleted room still leaves the global totals behind.
// Seed days sit in 2020 — well before any other write in this suite — so
// the day-boundary probes stay deterministic even though DO storage
// persists across tests in a file.
import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { utcDay } from "../../apps/server/src/control/budgets";
import { injectOutboxDeps } from "../../apps/server/src/rooms/aggregate-outbox";
import {
  controlStub,
  injectDeps,
  LIVE,
  okUpstream,
  restoreDefaultDeps,
  testState,
  useDay,
  type Upstream,
} from "./budget-helpers";
import { namedRoom, NOW } from "./room-helpers";
import { assertWiped, finishWinner } from "./room-deletion-helpers";
import { BASE, GOOD_ORIGIN } from "./ws-helpers";

afterEach(() => {
  restoreDefaultDeps();
  injectOutboxDeps(null);
});

const seed = async (dayMs: number, games: number, tag: string): Promise<void> => {
  const res = await controlStub().submitAggregate({
    receiptId: `stats38-${tag}`,
    completedGames: games,
    totalMessages: games * 4,
    totalDurationMs: games * 7_000,
    nowMs: dayMs,
  });
  expect(res).toEqual({ ok: true, dedupe: false });
};

test("public stats stay pending under 20 completed games, then publish totals", async () => {
  const dayA = Date.parse("2020-06-01T12:00:00Z");
  const probeA = Date.parse("2020-06-02T00:00:00Z");
  await seed(dayA, 19, "a-19");
  expect(await controlStub().publicStats({ nowMs: probeA })).toEqual({ status: "pending" });

  const dayB = Date.parse("2020-06-02T12:00:00Z");
  const probeB = Date.parse("2020-06-03T00:00:00Z");
  await seed(dayB, 1, "b-1");
  expect(await controlStub().publicStats({ nowMs: probeB })).toEqual({
    status: "ok",
    completedGames: 20,
    totalMessages: 80,
    totalDurationMs: 140_000,
    averageDurationMs: 7_000,
  });
});

test("a duplicate receiptId inside 24h counts once", async () => {
  const t = Date.parse("2020-06-04T12:00:00Z");
  const before = await controlStub().aggregateTotals();
  const input = { receiptId: "stats38-dupe", completedGames: 1, totalMessages: 3 };
  const a = await controlStub().submitAggregate({ ...input, totalDurationMs: 500, nowMs: t });
  const b = await controlStub().submitAggregate({ ...input, totalDurationMs: 500, nowMs: t });
  expect(a).toEqual({ ok: true, dedupe: false });
  expect(b).toEqual({ ok: true, dedupe: true });
  const totals = await controlStub().aggregateTotals();
  expect(totals.completedGames - before.completedGames).toBe(1);
  expect(totals.totalMessages - before.totalMessages).toBe(3);
  expect(totals.totalDurationMs - before.totalDurationMs).toBe(500);
});

test("a closed/deleted room still leaves the global totals intact", async () => {
  testState.dayMs = useDay("2027-03-20");
  const upstream: Upstream = { sent: 0 };
  injectDeps({ fetch: okUpstream(upstream) });
  // Pin the outbox clock to the (future) game time so the pending row is
  // due immediately; the sink stays the real ControlPlane binding.
  const clock = { now: NOW + 10_000 };
  injectOutboxDeps({ nowMs: () => clock.now });

  const { stub } = namedRoom("stats38-del");
  await stub.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: NOW });
  // Sample before the finish: the settle apply waitUntil'd flushes that
  // may already have landed, so the delta must be measured from here.
  const before = await controlStub().aggregateTotals();
  await finishWinner(stub, "s38");
  // The finish already waitUntil'd a flush; this direct drive makes the
  // submission deterministic — the dedupe key makes a double run harmless.
  await runInDurableObject(stub, (i) => i.driveOutbox());
  const totals = await controlStub().aggregateTotals();
  expect(totals.completedGames - before.completedGames).toBe(1);
  expect(totals.totalMessages - before.totalMessages).toBe(1);
  expect(totals.totalDurationMs - before.totalDurationMs).toBe(4_000);

  await stub.retireRoom();
  await assertWiped(stub);
  expect(await controlStub().aggregateTotals()).toEqual(totals);
});

test("GET /api/stats returns the numbers-only public payload", async () => {
  // 20 seeds on the UTC day before today push the public window over the
  // pending threshold. Earlier tests in this file also wrote to the ledger,
  // so the assertions are lower bounds plus the exact field shape — the
  // contract being pinned is "numbers only, nothing per-room or per-user".
  const dayMs = Date.parse(`${utcDay(Date.now())}T00:00:00Z`) - 12 * 60 * 60 * 1000;
  for (let i = 0; i < 20; i += 1) {
    await seed(dayMs, 1, `http-${i}`);
  }
  const res = await SELF.fetch(`${BASE}/api/stats`, { headers: { origin: GOOD_ORIGIN } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([
    "averageDurationMs",
    "completedGames",
    "status",
    "totalDurationMs",
    "totalMessages",
  ]);
  expect(body.status).toBe("ok");
  expect(body.completedGames).toBeGreaterThanOrEqual(20);
  expect(body.totalMessages).toBeGreaterThanOrEqual(80);
  expect(body.totalDurationMs).toBeGreaterThanOrEqual(140_000);
  expect(body.averageDurationMs).toBe(
    Math.round(Number(body.totalDurationMs) / Number(body.completedGames)),
  );
  // No room ids, player ids, receipts or content strings in the payload.
  expect(JSON.stringify(body)).not.toMatch(/roomId|playerId|receipt|displayName|post|text/i);
});
