// Task 26: the settings contract — fixed duration/round menus (devMode
// keeps the sandbox ranges for local /play), the earlyDecision/hostDecision
// switches defaulting OFF, and the reducer-level gates that reject the
// matching actions while a flag is off. Pure reducer, no I/O.
import { expect, test } from "bun:test";
import { type GameSettings, reduce } from "@yuragoo/game-core";
import { adhereTo, created, dwell, ids, live, rejected, settings, started } from "./rules-helpers";

test("Task 26 contract: only the fixed duration/round menus are accepted", () => {
  const mk = (over: Partial<GameSettings>) =>
    ({ type: "create", settings: settings(over), playerIds: ids(4), nowMs: 0 }) as const;
  // TURN slots: 10/20/30/45/60 only — in-between and out-of-menu values reject.
  for (const bad of [5, 15, 40, 90, 300]) {
    rejected(null, mk({ turnSeconds: bad }), "bad-state");
  }
  for (const good of [10, 20, 30, 45, 60]) {
    expect(reduce(null, mk({ turnSeconds: good })).state.settings.turnSeconds).toBe(good);
  }
  // Rounds: integer 1..8 — 9+ and non-integers reject.
  rejected(null, mk({ rounds: 0 }), "bad-state");
  rejected(null, mk({ rounds: 9 }), "bad-state");
  rejected(null, mk({ rounds: 2.5 }), "bad-state");
  for (const good of [1, 5, 8]) {
    expect(reduce(null, mk({ rounds: good })).state.settings.rounds).toBe(good);
  }
  // LIVE durations: 60/120/180/300/600 only.
  for (const bad of [30, 90, 240, 1800]) {
    rejected(null, mk({ liveSeconds: bad }), "bad-state");
  }
  for (const good of [60, 120, 180, 300, 600]) {
    expect(reduce(null, mk({ liveSeconds: good })).state.settings.liveSeconds).toBe(good);
  }
  // devMode keeps the sandbox ranges (local /play tuning).
  const dev = (over: Partial<GameSettings>) =>
    ({
      type: "create",
      settings: settings({ devMode: true, ...over }),
      playerIds: ids(4),
      nowMs: 0,
    }) as const;
  expect(reduce(null, dev({ turnSeconds: 300 })).state.settings.turnSeconds).toBe(300);
  expect(reduce(null, dev({ liveSeconds: 90 })).state.settings.liveSeconds).toBe(90);
  rejected(null, dev({ turnSeconds: 301 }), "bad-state");
});

test("Task 26: earlyDecision/hostDecision resolve to false by default", () => {
  // A settings object that simply omits the switches (what production
  // callers send) resolves both OFF — fixtures opt IN explicitly.
  const bare = reduce(null, {
    type: "create",
    settings: { mode: "turn", seed: 7, rosterSize: 4 },
    playerIds: ids(4),
    nowMs: 0,
  }).state;
  expect(bare.settings.earlyDecision).toBe(false);
  expect(bare.settings.hostDecision).toBe(false);
  const on = created(4); // the shared fixture opts both switches on
  expect(on.settings.earlyDecision).toBe(true);
  expect(on.settings.hostDecision).toBe(true);
});

test("Task 26: the feature flags gate every early-end path in the reducer", () => {
  // Disabled flags reject BEFORE any other check — a forced action can
  // never reach the behaviour (the gates are reducer-authoritative).
  const off = live(4, { earlyDecision: false, hostDecision: false }).state;
  expect(off.settings.earlyDecision).toBe(false);
  expect(off.settings.hostDecision).toBe(false);
  rejected(off, { type: "adhere", slot: 0, nowMs: 6_000 }, "bad-state");
  rejected(off, { type: "dwell-complete", nowMs: 6_000 }, "bad-state");
  rejected(off, { type: "request-end", playerId: "aiko", nowMs: 6_000 }, "bad-state");
  // Even on a hand-forged adhering state the dwell can't complete while
  // the flag is off.
  const stuck = { ...off, adhesion: { slot: 0, sinceMs: 1_000 } };
  rejected(stuck, { type: "dwell-complete", nowMs: 60_000 }, "bad-state");
  // TURN fairness: with the flag ON, round 0 still can't dwell — at least
  // one full round must have completed.
  const t0 = started(4, { earlyDecision: true }, 5_000).state;
  expect(t0.round).toBe(0);
  const tAdhere = adhereTo(t0, 0, 6_000).state;
  rejected(tAdhere, { type: "dwell-complete", nowMs: 9_500 }, "bad-state");
  // After the first round the same dwell passes its round gate (the hold
  // check still applies).
  const t1 = { ...tAdhere, round: 1 };
  expect(dwell(t1, 9_500).state.phase).toBe("complete");
});
