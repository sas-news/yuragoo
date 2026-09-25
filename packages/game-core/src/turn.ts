// TURN-mode rule helpers: per-round turn-order rotation and advancing to
// the next player or round. Pure — the only clock input is the nowMs the
// caller passes in.
import type { GameCommand, GameTransition } from "./commands";
import { enterComplete } from "./settlement";
import {
  GameRuleError,
  type GameState,
  type Player,
  type PlayerId,
  type PostedInput,
} from "./state";

// Turn order is a plain repeating cycle of the roster: ABAB for two
// players, ABCABC for three — no per-round rotation (players found the
// boundary repeat ("A again") confusing).
export const orderForRound = (roster: readonly Player[], _round: number): PlayerId[] =>
  roster.map((p) => p.id);

export const currentTurnPlayer = (state: GameState): PlayerId => {
  const id = state.turnOrder[state.turnIndex];
  if (id === undefined) {
    throw new GameRuleError("bad-state", "turnIndex out of range");
  }
  return id;
};

// Shared tail of a turn end: `passed` event then the advance (which may
// itself close into the settle window on the last turn of the last round).
export const passTurn = (state: GameState, playerId: PlayerId, nowMs: number): GameTransition => {
  const advanced = advanceTurn(state, nowMs);
  const passed: GameCommand = { type: "publish", event: { type: "passed", playerId } };
  return { state: advanced.state, commands: [passed, ...advanced.commands] };
};

// A voluntary pass ends the turn early — identical advance to a deadline
// expiry, but nowMs is the real wall clock so rapid passing can never push
// the game's clock (and the settle window) into the future.
export const passAction = (state: GameState, playerId: PlayerId, nowMs: number): GameTransition => {
  if (state.phase !== "playing") {
    throw new GameRuleError("not-playing", "pass requires the playing phase");
  }
  if (state.settings.mode !== "turn") {
    throw new GameRuleError("bad-state", "pass is only available in turn mode");
  }
  if (currentTurnPlayer(state) !== playerId) {
    throw new GameRuleError("not-your-turn", "only the current turn player may pass");
  }
  return passTurn(state, playerId, nowMs);
};

// Advance to the next turn. When the last turn of the last round ends, the
// game enters "complete" via the shared settle-window transition and no
// further turn commands are emitted.
export const advanceTurn = (state: GameState, nowMs: number): GameTransition => {
  const size = state.roster.length;
  let round = state.round;
  let turnIndex = state.turnIndex + 1;
  if (turnIndex >= size) {
    round += 1;
    turnIndex = 0;
  }
  if (round >= state.settings.rounds) {
    return enterComplete({ ...state, round, turnIndex, turnPosterId: null }, nowMs, "rounds");
  }
  // The order only changes on a round boundary; within a round the same
  // array is shared with the previous state.
  const turnOrder = turnIndex === 0 ? orderForRound(state.roster, round) : state.turnOrder;
  const deadlineAtMs = nowMs + state.settings.turnSeconds * 1000;
  const next: GameState = {
    ...state,
    round,
    turnIndex,
    turnOrder,
    deadlineAtMs,
    turnPosterId: null,
  };
  const commands: GameCommand[] = [
    { type: "publish", event: { type: "turn", round, playerId: currentTurnPlayer(next) } },
    { type: "set-deadline", atMs: deadlineAtMs, tag: "turn" },
  ];
  return { state: next, commands };
};

// TURN accept: only the current player may post, at most once per turn.
// Both checks run before any state is built, so a rejection is free.
export const acceptTurnPost = (
  state: GameState,
  playerId: PlayerId,
  text: string,
  nowMs: number,
): GameTransition => {
  if (playerId !== currentTurnPlayer(state)) {
    throw new GameRuleError("not-your-turn", `it is not ${playerId}'s turn`);
  }
  if (state.turnPosterId === playerId) {
    throw new GameRuleError("already-posted", "player already posted this turn");
  }
  const seq = state.seq + 1;
  const post: PostedInput = {
    postId: `p${seq}`,
    playerId,
    text,
    postedAtMs: nowMs,
    seq,
    status: "pending",
  };
  const posted: GameState = {
    ...state,
    posts: [...state.posts, post],
    seq,
    turnPosterId: playerId,
    // An accepted post is pending evaluation and may reverse the leader —
    // it always releases the dwell; the client re-reports adhere after.
    adhesion: null,
  };
  const advanced = advanceTurn(posted, nowMs);
  const commands: GameCommand[] = [
    { type: "evaluate", postId: post.postId, seq },
    { type: "publish", event: { type: "posted", postId: post.postId, playerId } },
    ...advanced.commands,
  ];
  return { state: advanced.state, commands };
};
