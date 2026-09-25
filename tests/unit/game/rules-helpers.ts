// Shared fixtures for Task 12 rule tests: synthetic roster ids, settings
// factories, action runners and a rejection assertion that also proves the
// input state was left bit-identical. Pure — no clocks, no I/O.
import { expect } from "bun:test";
import {
  type GameAction,
  GameRuleError,
  type GameRuleRejection,
  type GameSettings,
  type GameState,
  type GameTransition,
  reduce,
  type SettleClaim,
} from "@yuragoo/game-core";

// Synthetic fixture roster (あいこ/れん/むぎ/そら/はる/りく, romanised to fit
// the player id pattern).
export const IDS = ["aiko", "ren", "mugi", "sora", "haru", "riku"] as const;

export const ids = (n: number): string[] => IDS.slice(0, n);

export const settings = (over: Partial<GameSettings> = {}): GameSettings => ({
  mode: "turn",
  seed: 7,
  rosterSize: 4,
  // Task 26: fixtures exercise the ENABLED early/host-decision paths by
  // default (pre-Task-26 behaviour); the gate tests opt out explicitly.
  earlyDecision: true,
  hostDecision: true,
  ...over,
});

export const created = (n = 4, over: Partial<GameSettings> = {}, nowMs = 1_000): GameState =>
  reduce(null, {
    type: "create",
    settings: settings({ ...over, rosterSize: n }),
    playerIds: ids(n),
    nowMs,
  }).state;

export const started = (n = 4, over: Partial<GameSettings> = {}, nowMs = 5_000): GameTransition =>
  reduce(created(n, over), { type: "start", nowMs });

export const live = (n = 4, over: Partial<GameSettings> = {}, nowMs = 5_000): GameTransition =>
  started(n, { mode: "live", ...over }, nowMs);

export const post = (
  state: GameState,
  playerId: string,
  nowMs: number,
  text = `post-${state.seq + 1}`,
): GameTransition => reduce(state, { type: "post", playerId, text, nowMs });

export const pass = (state: GameState, nowMs: number): GameTransition =>
  reduce(state, { type: "deadline-reached", nowMs });

// Task 14 runners: early-decision and settlement actions.
export const adhereTo = (state: GameState, slot: number, nowMs: number): GameTransition =>
  reduce(state, { type: "adhere", slot, nowMs });

export const dwell = (state: GameState, nowMs: number): GameTransition =>
  reduce(state, { type: "dwell-complete", nowMs });

export const endRequest = (state: GameState, playerId: string, nowMs: number): GameTransition =>
  reduce(state, { type: "request-end", playerId, nowMs });

export const settleAs = (state: GameState, claim: SettleClaim, nowMs: number): GameTransition =>
  reduce(state, { type: "settle", nowMs, claim });

export const settleExpire = (state: GameState, nowMs: number): GameTransition =>
  reduce(state, { type: "settle-deadline", nowMs });

// Fire deadline-reached and keep only the state (for completed fixtures).
export const closeAt = (state: GameState, nowMs: number): GameState =>
  reduce(state, { type: "deadline-reached", nowMs }).state;

// A LIVE game closed at its match deadline (phase "complete", cutoff = seq).
export const completedLive = (n = 4, over: Partial<GameSettings> = {}): GameState => {
  const s = live(n, over).state;
  return closeAt(s, s.deadlineAtMs);
};

// A TURN game closed by round exhaustion: 2 players, 1 round, both posted.
export const completedTurn = (over: Partial<GameSettings> = {}): GameState => {
  let s = started(2, { rounds: 1, ...over }, 5_000).state;
  s = post(s, current(s), 6_000).state;
  return post(s, current(s), 7_000).state;
};

// Mark every pending post evaluated (cutoff fully covered -> "call0").
export const evaluateAll = (state: GameState): GameState => {
  let s = state;
  for (const p of s.posts) {
    if (p.status === "pending") s = reduce(s, { type: "evaluated", postId: p.postId }).state;
  }
  return s;
};

export const current = (state: GameState): string => {
  const id = state.turnOrder[state.turnIndex];
  if (id === undefined) throw new Error("no current player");
  return id;
};

// Asserts the action throws GameRuleError with `reason` AND that the input
// state is untouched (no field mutated, no commands produced).
export const rejected = (
  state: GameState | null,
  action: GameAction,
  reason: GameRuleRejection,
): void => {
  const snapshot = JSON.stringify(state);
  try {
    reduce(state, action);
  } catch (e) {
    if (!(e instanceof GameRuleError)) throw e;
    expect(e.reason).toBe(reason);
    expect(JSON.stringify(state)).toBe(snapshot);
    return;
  }
  throw new Error(`expected GameRuleError(${reason})`);
};
