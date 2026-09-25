// Task 12: pure TURN/LIVE game rules — seeded roster fairness, the fixed
// per-round turn cycle, deadlines, pending-slot caps, abort and rejection
// immutability.
import { expect, test } from "bun:test";
import { type GameSettings, type GameState, reduce } from "@yuragoo/game-core";
import {
  created,
  current,
  ids,
  live,
  pass,
  post,
  rejected,
  settings,
  started,
} from "./rules-helpers";

test("happy: seeded shuffle is deterministic and varies by seed", () => {
  // Given two creates with the same seed, Then identical order and slots
  const a = created(6, { seed: 42 });
  const b = created(6, { seed: 42 });
  expect(a.roster.map((p) => p.id)).toEqual(b.roster.map((p) => p.id));
  expect(a.roster.map((p) => p.slot)).toEqual([0, 1, 2, 3, 4, 5]);
  // And across seeds 1..20 the order differs somewhere
  const orders = new Set(
    Array.from({ length: 20 }, (_, i) =>
      created(6, { seed: i + 1 })
        .roster.map((p) => p.id)
        .join(","),
    ),
  );
  expect(orders.size).toBeGreaterThan(1);
});

test("happy: 2/4/6 players x 3 rounds give every player equal slots", () => {
  for (const n of [2, 4, 6]) {
    // Given a started TURN game, When posting on even turns and passing odd
    let s = started(n).state;
    const turns = new Map<string, number>();
    for (let step = 0; s.phase === "playing" && step < 100; step += 1) {
      const who = current(s);
      turns.set(who, (turns.get(who) ?? 0) + 1);
      s = step % 2 === 0 ? post(s, who, s.deadlineAtMs - 1).state : pass(s, s.deadlineAtMs).state;
    }
    // Then the game completes and every player held exactly `rounds` turns
    expect(s.phase).toBe("complete");
    for (const p of s.roster) expect(turns.get(p.id)).toBe(3);
    expect(s.seq).toBe(s.posts.length);
  }
});

test("happy: start emits deadline, started and first-turn commands", () => {
  // Given a lobby, When started at 5000 with 20s turns
  const t = started(4, { turnSeconds: 20 }, 5_000);
  // Then playing begins with a turn deadline and ordered commands
  expect(t.state.phase).toBe("playing");
  expect(t.state.startedAtMs).toBe(5_000);
  expect(t.state.deadlineAtMs).toBe(25_000);
  expect(t.commands).toEqual([
    { type: "set-deadline", atMs: 25_000, tag: "turn" },
    { type: "publish", event: { type: "started", roster: t.state.roster } },
    { type: "publish", event: { type: "turn", round: 0, playerId: current(t.state) } },
  ]);
  // And LIVE uses the match tag and emits no turn event
  const l = live(2, { liveSeconds: 60 });
  expect(l.commands).toEqual([
    { type: "set-deadline", atMs: 65_000, tag: "match" },
    { type: "publish", event: { type: "started", roster: l.state.roster } },
  ]);
});

test("happy: deadline pass emits passed and renews the turn deadline", () => {
  // Given a started 4-player TURN game with 10s turns
  let s = started(4, { turnSeconds: 10 }, 5_000).state;
  const first = current(s);
  // When the deadline hits without a post
  const t = pass(s, 15_000);
  // Then the player is passed, the turn advances and the deadline renews
  expect(t.commands[0]).toEqual({ type: "publish", event: { type: "passed", playerId: first } });
  expect(t.state.turnIndex).toBe(1);
  expect(t.state.deadlineAtMs).toBe(25_000);
  expect(current(t.state)).not.toBe(first);
  // And passing the whole game completes with zero posts
  while (s.phase === "playing") s = pass(s, s.deadlineAtMs).state;
  expect(s.phase).toBe("complete");
  expect(s.posts).toHaveLength(0);
});

test("happy: turn order repeats the plain roster cycle every round", () => {
  // Given a 3-player game, every round walks the same A→B→C order — no
  // per-round rotation (users read ABAB/ABCABC as "fair").
  const s = started(3).state;
  const base = s.turnOrder;
  const walk = (st: GameState, steps: number): GameState => {
    let cur = st;
    for (let i = 0; i < steps; i += 1) cur = pass(cur, cur.deadlineAtMs).state;
    return cur;
  };
  const r1 = walk(s, 3);
  expect(r1.round).toBe(1);
  expect(r1.turnOrder).toEqual(base);
  const r2 = walk(r1, 3);
  expect(r2.turnOrder).toEqual(base);
});

test("happy: accepted TURN post emits evaluate, posted, turn, deadline", () => {
  const s = started(4, { turnSeconds: 30 }, 5_000).state;
  const me = current(s);
  const t = post(s, me, 6_000, "go left");
  expect(t.state.posts[0]).toEqual({
    postId: "p1",
    playerId: me,
    text: "go left",
    postedAtMs: 6_000,
    seq: 1,
    status: "pending",
  });
  expect(t.commands).toEqual([
    { type: "evaluate", postId: "p1", seq: 1 },
    { type: "publish", event: { type: "posted", postId: "p1", playerId: me } },
    { type: "publish", event: { type: "turn", round: 0, playerId: current(t.state) } },
    { type: "set-deadline", atMs: 36_000, tag: "turn" },
  ]);
});

test("happy: last post of the last round completes into the settle window", () => {
  // Given the final turn of a 2-player 1-round game — the last post pins
  // the cutoff and arms the settle window instead of a new turn deadline
  let s = started(2, { rounds: 1 }).state;
  s = post(s, current(s), 6_000).state;
  const t = post(s, current(s), 7_000);
  expect(t.state.phase).toBe("complete");
  expect(t.state.settleCutoffSeq).toBe(2);
  expect(t.state.settleDeadlineAtMs).toBe(15_000);
  expect(t.state.endCause).toBe("rounds");
  const kinds = t.commands.map((c) => c.type);
  expect(kinds).toEqual(["evaluate", "publish", "set-deadline", "publish"]);
});

test("happy: LIVE accepts posts until the 120s deadline edge", () => {
  // Given a started LIVE game with the default 120s match deadline
  const t = live(4);
  expect(t.state.deadlineAtMs).toBe(125_000);
  // When posting at 119.999s, Then accepted; at exactly 120.000s, too-late
  const ok = post(t.state, "aiko", 124_999);
  expect(ok.state.posts).toHaveLength(1);
  rejected(ok.state, { type: "post", playerId: "ren", text: "hi", nowMs: 125_000 }, "too-late");
  // And deadline-reached closes gameplay into complete
  const done = reduce(ok.state, { type: "deadline-reached", nowMs: 125_000 });
  expect(done.state.phase).toBe("complete");
  rejected(
    done.state,
    { type: "post", playerId: "ren", text: "hi", nowMs: 125_001 },
    "not-playing",
  );
});

test("happy: LIVE pending-slot frees after evaluated", () => {
  // Given a LIVE game where aiko has one pending post
  const s1 = post(live(4).state, "aiko", 6_000).state;
  // Then a second post while it is pending is rejected
  rejected(s1, { type: "post", playerId: "aiko", text: "more", nowMs: 7_000 }, "pending-slot");
  // But another player is unaffected
  const s2 = post(s1, "ren", 7_000).state;
  expect(s2.posts).toHaveLength(2);
  // When aiko's first post is evaluated, her slot frees
  const s3 = reduce(s2, { type: "evaluated", postId: "p1" }).state;
  expect(s3.posts[0]?.status).toBe("evaluated");
  expect(post(s3, "aiko", 8_000).state.posts).toHaveLength(3);
});

test("happy: abort finishes with noContest outcome and commands", () => {
  const t = reduce(started(4).state, { type: "abort" });
  expect(t.state.phase).toBe("finished");
  expect(t.state.outcome).toEqual({ kind: "noContest", reason: "aborted" });
  expect(t.commands.map((c) => c.type)).toEqual(["finish", "publish"]);
  expect(t.commands[0]).toMatchObject({ type: "finish", outcome: { reason: "aborted" } });
  // And aborting from the lobby works too
  expect(reduce(created(4), { type: "abort" }).state.phase).toBe("finished");
});

test("failure: roster size, count and player id rules reject bad games", () => {
  // 1 player without devMode, 7 players, count mismatch, dup ids, bad pattern
  const mk = (rosterSize: number, playerIds: readonly string[]) =>
    ({ type: "create", settings: settings({ rosterSize }), playerIds, nowMs: 0 }) as const;
  rejected(null, mk(1, ["aiko"]), "bad-state");
  rejected(null, mk(7, [...ids(6), "seven"]), "bad-state");
  rejected(null, mk(0, []), "bad-state");
  rejected(null, mk(3, ids(2)), "bad-state");
  rejected(null, mk(2, ["aiko", "aiko"]), "bad-state");
  rejected(null, mk(2, ["aiko", "bad id!"]), "bad-state");
  const solo = created(1, { devMode: true }); // solo sandbox allowed with devMode
  expect(solo.roster).toHaveLength(1);
});

test("failure: out-of-range settings knobs reject at create", () => {
  const mk = (over: Partial<GameSettings>) =>
    ({ type: "create", settings: settings(over), playerIds: ids(4), nowMs: 0 }) as const;
  rejected(null, mk({ turnSeconds: 301 }), "bad-state");
  rejected(null, mk({ turnSeconds: 0 }), "bad-state");
  rejected(null, mk({ rounds: 13 }), "bad-state");
  rejected(null, mk({ liveSeconds: 1801 }), "bad-state");
  rejected(null, mk({ maxPendingPerPlayer: 5 }), "bad-state");
  // And resolved settings are frozen so no mid-game change is possible
  const s = created(4);
  expect(Object.isFrozen(s.settings)).toBe(true);
  expect(s.settings).toMatchObject({ turnSeconds: 20, rounds: 3, liveSeconds: 120 });
  expect(s.settings.maxPendingPerPlayer).toBe(1);
});

test("failure: posts outside play, bad text and wrong turns reject", () => {
  // post before start -> not-playing; unknown player; blank; >200 chars
  const lobby = created(4);
  rejected(lobby, { type: "post", playerId: "aiko", text: "hi", nowMs: 2_000 }, "not-playing");
  const s = started(4).state;
  rejected(s, { type: "post", playerId: "ghost", text: "hi", nowMs: 6_000 }, "unknown-player");
  rejected(s, { type: "post", playerId: current(s), text: "   ", nowMs: 6_000 }, "empty-text");
  rejected(
    s,
    { type: "post", playerId: current(s), text: "x".repeat(201), nowMs: 6_000 },
    "too-long",
  );
  // Another player's turn -> not-your-turn
  const me = current(s);
  const other = s.roster.find((p) => p.id !== me)?.id ?? "none";
  rejected(s, { type: "post", playerId: other, text: "hi", nowMs: 6_000 }, "not-your-turn");
  // Same user twice in one turn: the turn has advanced -> not-your-turn,
  // and a state claiming an existing turn post -> already-posted
  const s2 = post(s, me, 6_000).state;
  rejected(s2, { type: "post", playerId: me, text: "again", nowMs: 6_001 }, "not-your-turn");
  rejected(
    { ...s, turnPosterId: me },
    { type: "post", playerId: me, text: "hi", nowMs: 6_000 },
    "already-posted",
  );
});

test("failure: start twice, early deadline and bad evaluated reject", () => {
  const lobby = created(4);
  rejected(lobby, { type: "deadline-reached", nowMs: 60_000 }, "bad-state");
  const t = started(4);
  rejected(t.state, { type: "start", nowMs: 6_000 }, "bad-state");
  rejected(t.state, { type: "deadline-reached", nowMs: t.state.deadlineAtMs - 1 }, "bad-state");
  rejected(t.state, { type: "evaluated", postId: "p1" }, "bad-state");
  // And double evaluation of the same post rejects
  const s2 = post(t.state, current(t.state), 6_000).state;
  const s3 = reduce(s2, { type: "evaluated", postId: "p1" }).state;
  rejected(s3, { type: "evaluated", postId: "p1" }, "bad-state");
});
