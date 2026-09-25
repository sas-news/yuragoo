// Task 14: final evaluation, optional early decision, no-winner-on-failure.
// The cutoff is pinned when gameplay closes, the settle window is bounded,
// dwell resets on every accepted post and the outcome is fixed exactly once.
import { expect, test } from "bun:test";
import { type GameAction, type GameSettings, reduce, type SettleClaim } from "@yuragoo/game-core";
import {
  adhereTo,
  closeAt,
  completedLive,
  completedTurn,
  created,
  current,
  dwell,
  endRequest,
  evaluateAll,
  ids,
  live,
  post,
  rejected,
  settings,
  settleAs,
  settleExpire,
  started,
} from "./rules-helpers";

test("happy: TURN exhaustion pins the cutoff and opens the settle window", () => {
  // Given a 2-player 1-round game, When the last turn's post lands
  let s = started(2, { rounds: 1 }, 5_000).state;
  s = post(s, current(s), 6_000).state;
  const t = post(s, current(s), 7_000);
  // Then gameplay closes: cutoff pinned, settle armed, no extra evaluate
  expect(t.state.phase).toBe("complete");
  expect(t.state.endCause).toBe("rounds");
  expect(t.state.settleCutoffSeq).toBe(2);
  expect(t.state.settleDeadlineAtMs).toBe(15_000);
  expect(t.commands).toEqual([
    { type: "evaluate", postId: "p2", seq: 2 },
    { type: "publish", event: { type: "posted", postId: "p2", playerId: current(s) } },
    { type: "set-deadline", atMs: 15_000, tag: "settle" },
    { type: "publish", event: { type: "complete", cutoffSeq: 2, cause: "rounds" } },
  ]);
  // And once complete, the play and early-decision paths all reject
  rejected(t.state, { type: "post", playerId: "aiko", text: "x", nowMs: 8_000 }, "not-playing");
  rejected(t.state, { type: "adhere", slot: 0, nowMs: 8_000 }, "not-playing");
});

test("happy: a winner claim maps the slot to the roster player, once", () => {
  // Given a completed TURN game with every post evaluated
  const done = evaluateAll(completedTurn());
  const slot0 = done.roster[0];
  if (slot0 === undefined) throw new Error("roster is empty");
  // When the host settles with a winner claim inside the window
  const fin = settleAs(done, { kind: "winner", slot: 0 }, 10_000);
  // Then the slot maps through the roster and finish + publish are emitted
  const outcome = fin.state.outcome;
  if (outcome === null) throw new Error("settle produced no outcome");
  expect(fin.state.phase).toBe("finished");
  expect(outcome).toEqual({ kind: "winner", playerId: slot0.id, slot: 0 });
  expect(fin.commands).toEqual([
    { type: "finish", outcome },
    { type: "publish", event: { type: "finished", outcome } },
  ]);
  // And a second settle rejects — the outcome is decided exactly once
  rejected(fin.state, { type: "settle", nowMs: 11_000, claim: { kind: "draw" } }, "bad-state");
});

test("happy: LIVE deadline pins the cutoff; a 119.999s post is settleable", () => {
  // Given a LIVE game (deadline 125_000) with a post accepted at 119.999s
  const s0 = live(4).state;
  const s1 = post(s0, "aiko", 124_999).state;
  // When the match deadline fires, Then complete pins the cutoff over it
  const done = reduce(s1, { type: "deadline-reached", nowMs: 125_000 });
  expect(done.state.phase).toBe("complete");
  expect(done.state.endCause).toBe("deadline");
  expect(done.state.settleCutoffSeq).toBe(1);
  expect(done.state.settleDeadlineAtMs).toBe(133_000);
  expect(done.commands).toEqual([
    { type: "set-deadline", atMs: 133_000, tag: "settle" },
    { type: "publish", event: { type: "complete", cutoffSeq: 1, cause: "deadline" } },
  ]);
  // And a post at exactly 120.000s never enters the game (Task 12 contract)
  rejected(s0, { type: "post", playerId: "ren", text: "edge", nowMs: 125_000 }, "too-late");
  // When the cutoff post is evaluated, the winner claim settles normally
  const s2 = reduce(done.state, { type: "evaluated", postId: "p1" }).state;
  const slot = s2.roster.findIndex((p) => p.id === "aiko");
  const fin = settleAs(s2, { kind: "winner", slot }, 126_000);
  expect(fin.state.outcome).toEqual({ kind: "winner", playerId: "aiko", slot });
});

test("happy: a fully-evaluated cutoff completes with zero evaluate commands", () => {
  // Given a LIVE game whose only post was evaluated — completing emits
  // no new evaluate call ("cutoff既評価ならcall0")
  let s = live(4).state;
  s = post(s, "aiko", 6_000).state;
  s = reduce(s, { type: "evaluated", postId: "p1" }).state;
  const done = reduce(s, { type: "deadline-reached", nowMs: s.deadlineAtMs });
  expect(done.state.phase).toBe("complete");
  expect(done.commands.some((c) => c.type === "evaluate")).toBe(false);
});

test("failure: pending posts inside the cutoff force noContest, never a winner", () => {
  // Given a completed LIVE game with one post still pending — a winner
  // claim is forced to noContest (a state check, not a veto)
  const done = closeAt(post(live(4).state, "aiko", 6_000).state, 125_000);
  const fin = settleAs(done, { kind: "winner", slot: 0 }, 126_000);
  expect(fin.state.phase).toBe("finished");
  expect(fin.state.outcome).toEqual({ kind: "noContest", reason: "pending" });
  // And on the twin game where the post evaluated first, that claim wins
  const slot0 = done.roster[0];
  if (slot0 === undefined) throw new Error("roster is empty");
  const fin2 = settleAs(evaluateAll(done), { kind: "winner", slot: 0 }, 126_000);
  expect(fin2.state.outcome).toEqual({ kind: "winner", playerId: slot0.id, slot: 0 });
});

test("failure: the settle window rejects early expiry and late claims", () => {
  // Given a completed game whose settle deadline is +8s after closing
  const done = completedLive(4);
  const deadline = done.settleDeadlineAtMs ?? -1;
  expect(deadline).toBe(133_000);
  // Then expiry before the window ends rejects bad-state
  rejected(done, { type: "settle-deadline", nowMs: deadline - 1 }, "bad-state");
  // And a late claim rejects too-late — success after expiry flips nothing
  const late: GameAction = { type: "settle", nowMs: deadline + 1, claim: { kind: "draw" } };
  rejected(done, late, "too-late");
  // When the deadline fires, the game times out into noContest forever
  const fin = settleExpire(done, deadline).state;
  expect(fin.phase).toBe("finished");
  expect(fin.outcome).toEqual({ kind: "noContest", reason: "timeout" });
  rejected(fin, late, "bad-state");
});

test("happy: budget, draw and settle-phase rules hold", () => {
  // Given a playing game, the settle paths require the complete phase
  const playing = live(4).state;
  rejected(playing, { type: "settle", nowMs: 6_000, claim: { kind: "draw" } }, "bad-state");
  rejected(playing, { type: "settle-deadline", nowMs: 133_000 }, "bad-state");
  // Budget and draw claims pass straight through as the outcome
  const budget = settleAs(completedLive(), { kind: "noContest", reason: "budget" }, 126_000);
  expect(budget.state.outcome).toEqual({ kind: "noContest", reason: "budget" });
  const draw = settleAs(completedLive(), { kind: "draw" }, 126_000);
  expect(draw.state.outcome).toEqual({ kind: "draw" });
  // An out-of-roster slot or a forged "pending" claim is bad-state
  const s99 = { type: "settle", nowMs: 126_000, claim: { kind: "winner", slot: 99 } } as const;
  rejected(completedLive(), s99, "bad-state");
  const pendingClaim = { kind: "noContest", reason: "pending" } as unknown as SettleClaim;
  rejected(completedLive(), { type: "settle", nowMs: 126_000, claim: pendingClaim }, "bad-state");
});

test("happy: dwell completes at exactly adhesionSeconds with zero pending", () => {
  // Given a playing LIVE game where slot 1 adhered at t=60s — re-adhering
  // the same slot is idempotent; a different slot restarts the clock
  let s = adhereTo(live(4).state, 1, 60_000).state;
  s = adhereTo(s, 1, 61_000).state;
  expect(s.adhesion).toEqual({ slot: 1, sinceMs: 60_000 });
  s = adhereTo(s, 0, 62_000).state;
  expect(s.adhesion).toEqual({ slot: 0, sinceMs: 62_000 });
  // Bad slots reject; a beat before the 3s hold rejects; exactly 3s works
  rejected(s, { type: "adhere", slot: 4, nowMs: 62_500 }, "bad-state");
  rejected(s, { type: "adhere", slot: 1.5, nowMs: 62_500 }, "bad-state");
  rejected(s, { type: "dwell-complete", nowMs: 64_999 }, "bad-state");
  const t = dwell(s, 65_000);
  expect(t.state.phase).toBe("complete");
  expect(t.state.endCause).toBe("dwell");
  expect(t.commands).toEqual([
    { type: "set-deadline", atMs: 73_000, tag: "settle" },
    { type: "publish", event: { type: "complete", cutoffSeq: 0, cause: "dwell" } },
  ]);
});

test("failure: an accepted post releases the dwell and it must re-hold", () => {
  // Given a LIVE game dwelling on slot 0 since 60s — a post mid-dwell
  // clears the adhesion because the pending post may reverse the leader
  let s = adhereTo(live(4).state, 0, 60_000).state;
  s = post(s, "aiko", 61_000).state;
  expect(s.adhesion).toBeNull();
  rejected(s, { type: "dwell-complete", nowMs: 64_000 }, "bad-state");
  // And evaluated does NOT restore it — the client re-reports adhere
  s = reduce(s, { type: "evaluated", postId: "p1" }).state;
  expect(s.adhesion).toBeNull();
  rejected(s, { type: "dwell-complete", nowMs: 64_000 }, "bad-state");
  // Then a fresh adhere restarts sinceMs for the full hold again
  s = adhereTo(s, 0, 65_000).state;
  rejected(s, { type: "dwell-complete", nowMs: 67_999 }, "bad-state");
  expect(dwell(s, 68_000).state.phase).toBe("complete");
  // And a dwell over a still-pending post never completes
  const p = adhereTo(post(live(4).state, "aiko", 6_000).state, 0, 60_000).state;
  rejected(p, { type: "dwell-complete", nowMs: 64_000 }, "bad-state");
});

test("happy: only the host may request an early end", () => {
  // Given a playing game whose default host is the room creator aiko
  const s = live(4).state;
  expect(s.settings.hostId).toBe("aiko");
  // A non-host request rejects not-host, leaving the state untouched
  rejected(s, { type: "request-end", playerId: "ren", nowMs: 60_000 }, "not-host");
  // The host's request completes as "host" with end-requested published
  // ahead of the settle commands so clients can tell it from a timer
  const t = endRequest(s, "aiko", 60_000);
  expect(t.state.phase).toBe("complete");
  expect(t.state.endCause).toBe("host");
  expect(t.commands).toEqual([
    { type: "publish", event: { type: "end-requested", playerId: "aiko" } },
    { type: "set-deadline", atMs: 68_000, tag: "settle" },
    { type: "publish", event: { type: "complete", cutoffSeq: 0, cause: "host" } },
  ]);
});

test("failure: the first end trigger wins — racing triggers reject", () => {
  // Given a host-ended game, racing deadline/dwell/request all reject
  const byHost = endRequest(live(4).state, "aiko", 60_000).state;
  rejected(byHost, { type: "deadline-reached", nowMs: 125_000 }, "bad-state");
  rejected(byHost, { type: "request-end", playerId: "aiko", nowMs: 60_001 }, "not-playing");
  rejected(byHost, { type: "dwell-complete", nowMs: 60_001 }, "bad-state");
  // And the mirror: a deadline-complete kills a racing dwell/request
  const done = closeAt(adhereTo(live(4).state, 0, 60_000).state, 125_000);
  rejected(done, { type: "dwell-complete", nowMs: 125_000 }, "bad-state");
  rejected(done, { type: "request-end", playerId: "aiko", nowMs: 125_000 }, "not-playing");
});

test("failure: a finished game is immutable — the outcome never changes", () => {
  // Given a settle-deadline-finished game, every play/settle/abort path
  // rejects and the outcome field is referentially untouched
  const fin = settleExpire(completedLive(), 133_000).state;
  const before = fin.outcome;
  rejected(fin, { type: "settle", nowMs: 134_000, claim: { kind: "draw" } }, "bad-state");
  rejected(fin, { type: "settle-deadline", nowMs: 134_000 }, "bad-state");
  rejected(fin, { type: "abort" }, "bad-state");
  rejected(fin, { type: "post", playerId: "aiko", text: "x", nowMs: 134_000 }, "not-playing");
  rejected(fin, { type: "adhere", slot: 0, nowMs: 134_000 }, "not-playing");
  rejected(fin, { type: "request-end", playerId: "aiko", nowMs: 134_000 }, "not-playing");
  expect(fin.outcome).toBe(before);
});

test("failure: adhesion/settle seconds and hostId validate at create", () => {
  const mk = (over: Partial<GameSettings>) =>
    ({ type: "create", settings: settings(over), playerIds: ids(4), nowMs: 0 }) as const;
  rejected(null, mk({ adhesionSeconds: 0 }), "bad-state");
  rejected(null, mk({ adhesionSeconds: 61 }), "bad-state");
  rejected(null, mk({ settleSeconds: 0 }), "bad-state");
  rejected(null, mk({ settleSeconds: 31 }), "bad-state");
  // hostId must name a joined player; the default is playerIds[0] pre-shuffle
  rejected(null, mk({ hostId: "ghost" }), "bad-state");
  expect(created(4).settings.hostId).toBe("aiko");
  // A custom hostId is honoured — authority follows the id, not the slot
  const s = live(4, { hostId: "ren" }).state;
  rejected(s, { type: "request-end", playerId: "aiko", nowMs: 6_000 }, "not-host");
  expect(endRequest(s, "ren", 6_000).state.phase).toBe("complete");
});
