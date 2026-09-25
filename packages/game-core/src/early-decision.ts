// Early-decision inputs (Task 26): a server-side watcher reports which
// roster slot the evaluated distributions have "adhered" to (sustained
// dominance), and the host may request an early end when the lobby enabled
// it. Both are optional accelerators into the same settle window — the
// first end trigger wins, and every accepted post releases the dwell so a
// late reversal always gets evaluated before the outcome is fixed.
//
// The feature flags are the REDUCER's authority, not a transport courtesy:
// a forced action that reaches this point while the flag is off rejects as
// bad-state, so no client or bypassed dispatch can enable them.
import type { GameCommand, GameTransition } from "./commands";
import { enterComplete } from "./settlement";
import { GameRuleError, type GameState, type PlayerId } from "./state";

const checkNowMs = (nowMs: number): void => {
  if (!Number.isFinite(nowMs)) {
    throw new GameRuleError("bad-state", "nowMs must be a finite number");
  }
};

const requireEarlyDecision = (state: GameState): void => {
  if (state.settings.earlyDecision !== true) {
    throw new GameRuleError("bad-state", "early decision is disabled for this match");
  }
};

const requireHostDecision = (state: GameState): void => {
  if (state.settings.hostDecision !== true) {
    throw new GameRuleError("bad-state", "host decision is disabled for this match");
  }
};

// adhere: the server watcher observed sustained dominance on `slot`. The
// same slot is idempotent (the original sinceMs is kept); a different slot
// restarts the dwell clock. Emits no commands — it only records the report.
export const adhere = (state: GameState, slot: number, nowMs: number): GameTransition => {
  checkNowMs(nowMs);
  requireEarlyDecision(state);
  if (state.phase !== "playing") {
    throw new GameRuleError("not-playing", "adhere requires the playing phase");
  }
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= state.roster.length) {
    throw new GameRuleError(
      "bad-state",
      `adhere slot must be a safe integer in 0..${state.roster.length - 1}`,
    );
  }
  if (state.adhesion !== null && state.adhesion.slot === slot) {
    return { state, commands: [] };
  }
  return { state: { ...state, adhesion: { slot, sinceMs: nowMs } }, commands: [] };
};

// dwellComplete: the dwell has held for adhesionSeconds and no post is
// still pending evaluation — close gameplay early through the normal
// settle window. TURN fairness (Task 26): at least one full round must have
// completed (round >= 1) so every member got a turn before an early end.
// Any violation rejects as bad-state.
export const dwellComplete = (state: GameState, nowMs: number): GameTransition => {
  checkNowMs(nowMs);
  requireEarlyDecision(state);
  if (state.phase !== "playing" || state.adhesion === null) {
    throw new GameRuleError("bad-state", "dwell-complete requires adhesion during play");
  }
  if (state.settings.mode === "turn" && state.round === 0) {
    throw new GameRuleError("bad-state", "dwell requires at least one completed round in TURN");
  }
  const heldMs = nowMs - state.adhesion.sinceMs;
  if (heldMs < state.settings.adhesionSeconds * 1000) {
    throw new GameRuleError("bad-state", "dwell has not held for adhesionSeconds yet");
  }
  if (state.posts.some((p) => p.status === "pending")) {
    throw new GameRuleError("bad-state", "dwell-complete requires zero pending posts");
  }
  return enterComplete(state, nowMs, "dwell");
};

// requestEnd: the host asks to close gameplay now. Any other player is
// not-host; the end-requested event is published ahead of the completion
// commands so clients can tell a host call from a timer.
export const requestEnd = (state: GameState, playerId: PlayerId, nowMs: number): GameTransition => {
  checkNowMs(nowMs);
  requireHostDecision(state);
  if (state.phase !== "playing") {
    throw new GameRuleError("not-playing", "request-end requires the playing phase");
  }
  if (playerId !== state.settings.hostId) {
    throw new GameRuleError("not-host", "only the host may request an early end");
  }
  const completed = enterComplete(state, nowMs, "host");
  const commands: GameCommand[] = [
    { type: "publish", event: { type: "end-requested", playerId } },
    ...completed.commands,
  ];
  return { state: completed.state, commands };
};
