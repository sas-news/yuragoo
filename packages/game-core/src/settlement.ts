// Settlement: once gameplay closes ("complete"), the accepted-post cutoff
// is pinned and a short settle window opens for the last evaluations to
// land. The host's claim — or the window's expiry — then fixes the single
// immutable outcome. The first end trigger wins; outcome is decided once.
import type { GameCommand, GameTransition } from "./commands";
import { type GameOutcome, resolveOutcome, type SettleClaim } from "./outcome";
import { type EndCause, GameRuleError, type GameState } from "./state";

// enterComplete: gameplay closes, the cutoff is pinned to the current seq
// and the settle deadline is armed. Emits ZERO evaluate commands — pending
// posts already emitted theirs at accept time, so a game whose cutoff is
// fully evaluated needs no further AI call ("cutoff既評価ならcall0").
export const enterComplete = (state: GameState, nowMs: number, cause: EndCause): GameTransition => {
  const settleDeadlineAtMs = nowMs + state.settings.settleSeconds * 1000;
  const next: GameState = {
    ...state,
    phase: "complete",
    adhesion: null,
    settleCutoffSeq: state.seq,
    settleDeadlineAtMs,
    endCause: cause,
  };
  const commands: GameCommand[] = [
    { type: "set-deadline", atMs: settleDeadlineAtMs, tag: "settle" },
    { type: "publish", event: { type: "complete", cutoffSeq: state.seq, cause } },
  ];
  return { state: next, commands };
};

const finished = (state: GameState, outcome: GameOutcome): GameTransition => ({
  state: { ...state, phase: "finished", outcome },
  commands: [
    { type: "finish", outcome },
    { type: "publish", event: { type: "finished", outcome } },
  ],
});

// settle: the host's claim inside the window fixes the outcome. A claim
// arriving after the deadline is too-late — a late success must never flip
// a game whose settle window already expired.
export const settle = (state: GameState, nowMs: number, claim: SettleClaim): GameTransition => {
  if (!Number.isFinite(nowMs)) {
    throw new GameRuleError("bad-state", "nowMs must be a finite number");
  }
  if (state.phase !== "complete") {
    throw new GameRuleError("bad-state", "settle requires the complete phase");
  }
  if (state.settleDeadlineAtMs !== null && nowMs > state.settleDeadlineAtMs) {
    throw new GameRuleError("too-late", "settle claim arrived after the settle deadline");
  }
  return finished(state, resolveOutcome(state, claim));
};

// settleDeadline: the armed deadline fired without a claim — the game ends
// noContest/timeout exactly once.
export const settleDeadline = (state: GameState, nowMs: number): GameTransition => {
  if (!Number.isFinite(nowMs)) {
    throw new GameRuleError("bad-state", "nowMs must be a finite number");
  }
  if (state.phase !== "complete" || state.settleDeadlineAtMs === null) {
    throw new GameRuleError("bad-state", "settle-deadline requires the complete phase");
  }
  if (nowMs < state.settleDeadlineAtMs) {
    throw new GameRuleError("bad-state", "settle deadline has not been reached yet");
  }
  return finished(state, { kind: "noContest", reason: "timeout" });
};
