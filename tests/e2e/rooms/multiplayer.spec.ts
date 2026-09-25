// Task 23 gate: multi-browser synchronized matches + recovery, end to end
// through the real wrangler worker and real browser contexts. Every action
// goes through window.__roomBridge — Jev calls are retargeted at the local
// fixture via JEV_UPSTREAM_URL, so the real provider is never contacted.
import { expect, test, type BrowserContext } from "@playwright/test";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectIdentical, FINISHED, proofs } from "./mp-assert";
import {
  closeClient,
  EVIDENCE_DIR,
  lastPhaseEvent,
  lastSeq,
  openPages,
  openRoom,
  type Seat,
  send,
  swallowFrames,
  waitFor,
  writeEvidence,
} from "./mp-bridge";
import { armedStart } from "./mp-lobby";
import {
  aggregateTotals,
  type JevFixture,
  PRIMARY_API_ORIGIN,
  R2_API_ORIGIN,
  R2_PAGE_ORIGIN,
  startJevFixture,
  startWorker,
  waitAggregate,
  waitHealthy,
} from "./mp-fixture";

const contexts: BrowserContext[] = [];
const restartLog: string[] = [];
const happy: Record<string, unknown> = {};
let fixture: JevFixture;

test.beforeAll(async () => {
  fixture = await startJevFixture();
});
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
});
test.afterAll(async () => {
  writeEvidence("task-23-happy.json", happy);
  writeEvidence("task-23-restart.log", `${restartLog.join("\n")}\n`);
  await fixture.close();
});

test("happy: 6-player LIVE match converges identically and aggregates once", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const ps = await openPages(browser, 6, contexts);
  const { seats } = await openRoom(ps);
  const [host] = seats as [Seat];
  const baseline = await aggregateTotals(PRIMARY_API_ORIGIN);
  await armedStart(seats, { mode: "live", seed: 11, liveSeconds: 60, hostDecision: true });
  for (const [i, s] of seats.entries()) {
    await send(s, "submitText", { text: `ライブ投稿${i}` });
  }
  await send(host, "requestDecision");
  for (const s of seats) await waitFor(s, FINISHED, 30_000);
  const got = await proofs(seats);
  for (const p of got) {
    expect(p.finishedFrame?.gameEpoch).toBe(1);
    expect((p.finished as { outcome?: { kind?: string } } | null)?.outcome?.kind).toBe("winner");
  }
  expectIdentical(got);
  happy.live6 = got;
  const totals = await waitAggregate(PRIMARY_API_ORIGIN, baseline.completedGames + 1);
  expect(totals.completedGames).toBe(baseline.completedGames + 1);
});

test("happy: 4-player TURN match plays every round to an identical finish", async ({ browser }) => {
  test.setTimeout(90_000);
  const ps = await openPages(browser, 4, contexts);
  const { seats } = await openRoom(ps);
  const [watcher] = seats as [Seat];
  await armedStart(seats, { mode: "turn", seed: 5, turnSeconds: 30, rounds: 2 });
  await waitFor(watcher, { kind: "event", type: "phaseChanged", eventType: "turn" }, 15_000);
  for (let step = 0; step < 12; step += 1) {
    const t = await lastPhaseEvent(watcher);
    if (t === null || t.type !== "turn") break;
    const poster = seats.find((s) => s.playerId === t.playerId);
    if (poster === undefined) throw new Error(`turn player ${t.playerId} not a seat`);
    await send(poster, "submitText", { text: `ターン投稿${step}` });
    await waitFor(watcher, { kind: "phaseEventAfter", seq: t.seq }, 15_000);
    if (step === 11) throw new Error("turn loop did not reach the end");
  }
  for (const s of seats) await waitFor(s, FINISHED, 30_000);
  const got = await proofs(seats);
  expectIdentical(got);
  happy.turn4 = got;
});

test("resync: a swallowed frame heals through syncRequest to identical state", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const ps = await openPages(browser, 3, contexts);
  const { seats } = await openRoom(ps);
  const [s0, s1, s2] = seats as [Seat, Seat, Seat];
  await armedStart(seats, { mode: "live", seed: 3, liveSeconds: 60 });
  await send(s1, "submitText", { text: "最初の投稿" });
  await waitFor(s2, { kind: "event", type: "inputAccepted" });
  await swallowFrames(s2, 1); // the next ordered frame never reaches sync
  await send(s2, "submitText", { text: "二つ目の投稿" });
  await send(s0, "submitText", { text: "三つ目の投稿" });
  // The gap triggers syncRequest -> a fresh snapshot heals the client.
  await waitFor(s2, { kind: "frames", type: "snapshot", minCount: 2 }, 15_000);
  const posts = await s2.page.evaluate(
    (id) => window.__roomBridge?.clients[id]?.snapshot?.state?.posts.length ?? -1,
    s2.id,
  );
  expect(posts).toBe(3); // the swallowed post is inside the snapshot
  await expect
    .poll(async () => (await lastSeq(s2)) === (await lastSeq(s0)), {
      timeout: 15_000,
    })
    .toBe(true);
  happy.resync = { healedTo: await lastSeq(s2) };
});

test("host exit mid-game: hostChanged lands and the match still finishes", async ({ browser }) => {
  test.setTimeout(90_000);
  const ps = await openPages(browser, 4, contexts);
  const { seats } = await openRoom(ps);
  const [host, next, third] = seats as [Seat, Seat, Seat];
  await armedStart(seats, { mode: "live", seed: 13, liveSeconds: 60, hostDecision: true });
  await send(third, "submitText", { text: "途中の投稿" });
  await closeClient(host);
  const rest = seats.slice(1);
  for (const s of rest) {
    await waitFor(s, { kind: "event", type: "presenceChanged", playerId: host.playerId });
    await waitFor(s, { kind: "event", type: "hostChanged", playerId: next.playerId });
  }
  await send(third, "submitText", { text: "引き継ぎの投稿" });
  await send(next, "requestDecision"); // the elected host can end it
  for (const s of rest) await waitFor(s, FINISHED, 30_000);
  const got = await proofs(rest);
  expectIdentical(got);
  happy.hostExit = got;
});

test("last-second post stays pending at timeup: noContest, never a fabricated winner", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const videoDir = mkdtempSync(join(tmpdir(), "yuragoo-t23-video-"));
  const ps = await openPages(browser, 3, contexts, videoDir);
  const { seats } = await openRoom(ps);
  const [host, poster] = seats as [Seat, Seat];
  fixture.mode = "hold"; // upstream calls park — the post can never resolve
  try {
    await armedStart(seats, {
      mode: "live",
      seed: 21,
      liveSeconds: 60,
      settleSeconds: 1,
      hostDecision: true,
    });
    await send(poster, "submitText", { text: "直前の投稿" });
    // Task 26: the hostDecision switch closes gameplay while the post pends.
    await send(host, "requestDecision");
    for (const s of seats) await waitFor(s, FINISHED, 40_000);
    const got = await proofs(seats);
    for (const p of got) {
      const outcome = (p.finished as { outcome?: { kind?: string; reason?: string } } | null)
        ?.outcome;
      expect(outcome?.kind).toBe("noContest");
      expect(outcome?.reason).toBe("timeout");
    }
    // The room still closes cleanly: every client gets roomClosed and the retry loop stops.
    void send(host, "closeRoom").catch(() => {});
    for (const s of seats) {
      await waitFor(s, { kind: "event", type: "roomClosed" });
      await waitFor(s, { kind: "closed" });
    }
    happy.lastSecondPending = got;
  } finally {
    fixture.releaseHeld();
    fixture.mode = "ok";
  }
  const video = ps[0]?.video();
  await ps[0]?.context().close();
  if (video !== null && video !== undefined) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    copyFileSync(await video.path(), join(EVIDENCE_DIR, "task-23-failure.webm"));
  }
});

test("server restart mid-match: clients resume the identical game and finish it", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(join(tmpdir(), "yuragoo-t23-mf-"));
  let worker = await startWorker({ port: 8899, dir, upstreamUrl: fixture.url });
  restartLog.push(`${new Date().toISOString()} worker#1 up on :8899`);
  await waitHealthy(R2_API_ORIGIN);
  const ps = await openPages(browser, 3, contexts);
  const { seats } = await openRoom(ps, R2_PAGE_ORIGIN);
  const [host, second, third] = seats as [Seat, Seat, Seat];
  const baseline = await aggregateTotals(R2_API_ORIGIN);
  await armedStart(seats, { mode: "live", seed: 17, liveSeconds: 120, hostDecision: true });
  await send(second, "submitText", { text: "再起動前の投稿" });
  await send(third, "submitText", { text: "二本目の投稿" });
  await waitFor(host, { kind: "event", type: "inputAccepted", minCount: 2 });
  // Evals must land pre-kill — orphaned jobs are suppressed on restart,
  // leaving posts pending and the match noContest, which never aggregates.
  await waitFor(host, { kind: "event", type: "decisionUpdated", minCount: 2 });
  restartLog.push("mid-match: 2 posts accepted and evaluated, epoch=1");
  await worker.dispose(); // workerd down, sockets severed
  worker = await startWorker({ port: 8899, dir, upstreamUrl: fixture.url });
  restartLog.push("worker#2 up over the same persist dir");
  await waitHealthy(R2_API_ORIGIN);
  for (const s of seats) await waitFor(s, { kind: "reconnects", min: 1 }, 45_000);
  restartLog.push("all clients re-admitted; the DOs rehydrated from SQLite");
  // Same game: the post-restart snapshot still shows both posts, epoch 1.
  for (const s of seats) {
    const posts = await s.page.evaluate(
      (id) => window.__roomBridge?.clients[id]?.snapshot?.state?.posts.length ?? -1,
      s.id,
    );
    expect(posts).toBe(2);
  }
  let ended = false; // whichever seat the election re-seated ends the match
  for (const s of seats) {
    if (ended) break;
    ended = await send(s, "requestDecision")
      .then(() => true)
      .catch(() => false); // non-host seats reject; the elected host lands
  }
  expect(ended).toBe(true);
  for (const s of seats) await waitFor(s, FINISHED, 40_000);
  const got = await proofs(seats);
  for (const p of got) {
    expect(p.finishedFrame?.gameEpoch).toBe(1);
    expect(p.reconnects).toBeGreaterThanOrEqual(1);
  }
  expectIdentical(got, false); // restart gaps differ; the outcome is one
  restartLog.push(`finished identically: ${JSON.stringify(got[0]?.finished)}`);
  const totals = await waitAggregate(R2_API_ORIGIN, baseline.completedGames + 1);
  expect(totals.completedGames).toBe(baseline.completedGames + 1);
  await worker.dispose();
});
