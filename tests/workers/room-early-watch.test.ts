// Task 26: the server-side early-decision watcher. Sustained dominance out
// of COMMITTED ai_results — never a client-reported dwell — arms a durable
// streak + dwell clock that closes gameplay through the normal reducer
// path. A post after the streak began resets the clock, the disabled
// switch never tracks, and TURN round 0 is always unfair to cut short.
import { afterEach, expect, test } from "vitest";
import { parseChoiceId, type DecisionDistribution } from "@yuragoo/protocol";
import type { UpstreamFetch } from "../../apps/server/src/rooms/decision-jobs";
import { dominanceSlot } from "../../apps/server/src/rooms/early-watch";
import {
  drive,
  injectDeps,
  poll,
  post,
  restoreDefaultDeps,
  type RoomStub,
  type Upstream,
} from "./budget-helpers";
import {
  deadlineRows,
  deliverAlarm,
  execSql,
  LIVE_SETTINGS,
  must,
  namedRoom,
  NOW,
  TURN_SETTINGS,
} from "./room-helpers";

const dist = (...ps: number[]): DecisionDistribution[] =>
  ps.map((p, i) => ({ choiceId: parseChoiceId(`c${i}`), probability: p }));

// Upstream that always lands the same dominant distribution (top >= 0.75).
const dominantUpstream =
  (u: Upstream, top = 0.9): UpstreamFetch =>
  async (_i, init) => {
    u.sent += 1;
    const body = JSON.parse(String(init?.body)) as {
      questions: { attraction: { criteria: Record<string, string> } };
    };
    const ids = Object.keys(body.questions.attraction.criteria);
    const rest = ids.length > 1 ? (1 - top) / (ids.length - 1) : 0;
    const probabilities: Record<string, number> = {};
    for (const [i, id] of ids.entries()) probabilities[id] = i === 0 ? top : rest;
    return Response.json({
      model: "jev-1.13.0",
      answers: {
        attraction: { type: "choice", choice: ids[0] ?? "a", confidence: 0.5, probabilities },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };

const watchRow = (stub: RoomStub) => execSql(stub, "SELECT slot, since_ms FROM early_watch");
// Park the dwell row so the next delivered alarm fires it; the alarm's own
// real-time clock then re-checks the persisted streak honestly.
const forceDwellDue = (stub: RoomStub) =>
  execSql(stub, "UPDATE deadlines SET run_at = 0 WHERE id = 'dwell'");

afterEach(() => restoreDefaultDeps());

test("dominanceSlot: the contract window is top>=0.75 and margin>=0.20", () => {
  expect(dominanceSlot(dist(0.75, 0.25))).toBe(0); // top exactly on the bar
  expect(dominanceSlot(dist(0.749, 0.251))).toBeNull();
  expect(dominanceSlot(dist(0.8, 0.6))).toBe(0); // margin exactly on the bar
  expect(dominanceSlot(dist(0.8, 0.61))).toBeNull();
  expect(dominanceSlot(dist(0.1, 0.9))).toBe(1);
  expect(dominanceSlot(dist(0.9))).toBe(0); // single choice is dominant
  expect(dominanceSlot([])).toBeNull();
});

test("watcher: dominant evals arm the dwell clock and close play early", async () => {
  // The streak's dwell clock fires on the REAL room alarm: sinceMs lands
  // just past the adhesionSeconds horizon so the hold clears honestly and
  // the match completes by "dwell" through the normal reducer path.
  const t0 = Date.now();
  let fake = t0;
  const upstream: Upstream = { sent: 0 };
  injectDeps({ fetch: dominantUpstream(upstream), nowMs: () => fake });
  const { stub } = namedRoom("watch-live");
  await stub.createRoom({
    settings: {
      ...LIVE_SETTINGS,
      liveSeconds: 300,
      adhesionSeconds: 10,
      devMode: true,
      earlyDecision: true,
    },
    playerIds: ["p1", "p2"],
    nowMs: t0 - 40_000,
  });
  await post(stub, "p1", 0, t0 - 39_000);
  fake = t0 - 15_000; // eval1 commits here -> streak sinceMs
  await drive(stub);
  expect(upstream.sent).toBe(1);
  // run_at = since + 10s is already behind — the armed alarm fires on its
  // own; poll the snapshot until the dwell completes the match.
  expect(await poll(async () => (await stub.snapshot()).state.phase !== "playing")).toBe(true);
  expect((await stub.snapshot()).state.endCause).toBe("dwell");
  expect(await watchRow(stub)).toHaveLength(0); // consumed by the fire
});

test("watcher: a post after the streak began resets the dwell clock", async () => {
  const t0 = Date.now();
  let fake = t0;
  const upstream: Upstream = { sent: 0 };
  injectDeps({ fetch: dominantUpstream(upstream), nowMs: () => fake });
  const { stub } = namedRoom("watch-reset");
  await stub.createRoom({
    settings: {
      ...LIVE_SETTINGS,
      liveSeconds: 300,
      adhesionSeconds: 30,
      devMode: true,
      earlyDecision: true,
    },
    playerIds: ["p1", "p2"],
    nowMs: t0 - 40_000,
  });
  await post(stub, "p1", 0, t0 - 39_000);
  fake = t0 - 5_000; // eval1 commits here -> dwell armed at t0+25s
  await drive(stub);
  expect(await watchRow(stub)).toHaveLength(1);
  expect((await deadlineRows(stub)).some((d) => d.tag === "dwell")).toBe(true);

  // A post accepted after the streak began resets the clock. eval2's own
  // drive may race the forced alarm either way — the outcome converges:
  // still playing, and the streak rests on the NEW sinceMs, never the old.
  fake = t0 - 3_000; // eval2's commit clock
  await post(stub, "p2", 1, t0 - 4_000);
  await forceDwellDue(stub);
  await deliverAlarm(stub);
  expect(await poll(async () => Number((await watchRow(stub))[0]?.since_ms) === t0 - 3_000)).toBe(
    true,
  );
  // the newer post saved the match — still playing
  expect((await stub.snapshot()).state.phase).toBe("playing");
});

test("watcher: earlyDecision off never tracks; TURN round 0 is fair", async () => {
  const upstream: Upstream = { sent: 0 };
  injectDeps({ fetch: dominantUpstream(upstream), nowMs: () => NOW + 5_000 });
  const { stub } = namedRoom("watch-off");
  await stub.createRoom({
    settings: { ...LIVE_SETTINGS, liveSeconds: 300, devMode: true }, // earlyDecision OFF
    playerIds: ["p1", "p2"],
    nowMs: NOW,
  });
  await post(stub, "p1", 0, NOW + 1_000);
  await drive(stub);
  expect(await watchRow(stub)).toHaveLength(0);
  expect((await deadlineRows(stub)).some((d) => d.tag === "dwell")).toBe(false);

  const { stub: turn } = namedRoom("watch-turn");
  await turn.createRoom({
    settings: { ...TURN_SETTINGS, earlyDecision: true },
    playerIds: ["p1", "p2"],
    nowMs: NOW,
  });
  const snap = await turn.snapshot();
  const cur = must(snap.state.turnOrder[snap.state.turnIndex], "turn player");
  await post(turn, cur, 0, NOW + 1_000);
  await drive(turn);
  // Round 0 is still in progress — the fairness floor keeps the streak off.
  expect(await watchRow(turn)).toHaveLength(0);
  expect((await deadlineRows(turn)).some((d) => d.tag === "dwell")).toBe(false);
});
