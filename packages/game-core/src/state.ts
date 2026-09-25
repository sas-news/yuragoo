// Core immutable game state shared by the TURN and LIVE rules. Every
// transition goes through reduce() in ./reducer; every rejection throws a
// GameRuleError with a stable `reason` BEFORE any new state is produced, so
// a rejected action leaves the input state referentially untouched.
import type { GameOutcome } from "./outcome";
import type { ResolvedGameSettings } from "./settings";

// GameOutcome lives in ./outcome (Task 14); re-exported here so existing
// `from "./state"` imports keep working. Type-only, so no runtime cycle.
export type { GameOutcome } from "./outcome";

export type GameRuleRejection =
  | "not-playing"
  | "too-late"
  | "unknown-player"
  | "not-your-turn"
  | "empty-text"
  | "too-long"
  | "already-posted"
  | "pending-slot"
  | "not-host"
  | "bad-state";

export class GameRuleError extends Error {
  readonly reason: GameRuleRejection;

  constructor(reason: GameRuleRejection, message: string) {
    super(message);
    this.name = "GameRuleError";
    this.reason = reason;
  }
}

export type PlayerId = string;
export const PLAYER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
export const isPlayerId = (value: string): value is PlayerId => PLAYER_ID_PATTERN.test(value);

export interface Player {
  readonly id: PlayerId;
  readonly slot: number; // index of the player's attractor/choice
}

export type PostStatus = "pending" | "evaluated";

export interface PostedInput {
  readonly postId: string; // deterministic `p<seq>`
  readonly playerId: PlayerId;
  readonly text: string; // original text, kept verbatim for display
  readonly postedAtMs: number;
  readonly seq: number;
  readonly status: PostStatus;
}

// "complete" means gameplay is closed and the game awaits settlement
// (Task 14): TURN exhausted its rounds, LIVE hit its match deadline, or an
// early-decision trigger fired. "finished" carries an outcome fixed forever.
export type GamePhase = "lobby" | "playing" | "complete" | "finished";

// What closed gameplay. Set exactly once by enterComplete — the first end
// trigger wins and later triggers are rejected by the phase check.
export type EndCause = "rounds" | "deadline" | "dwell" | "host";

// A client-reported dwell observation: the creature has been resting on
// this roster slot since sinceMs. Any accepted post clears it (the pending
// evaluation may reverse the leader) and the client re-reports afterwards.
export interface Adhesion {
  readonly slot: number;
  readonly sinceMs: number;
}

export interface GameState {
  readonly settings: ResolvedGameSettings; // frozen at create
  readonly phase: GamePhase;
  readonly roster: readonly Player[]; // seeded shuffle order, fixed
  readonly turnOrder: readonly PlayerId[]; // current round order (rotates per round)
  readonly round: number; // 0-based, TURN only
  readonly turnIndex: number; // index into turnOrder, TURN only
  readonly deadlineAtMs: number; // current turn deadline (TURN) or match end (LIVE)
  readonly posts: readonly PostedInput[]; // accepted inputs, append-only
  readonly seq: number; // monotonic post counter
  readonly startedAtMs: number;
  readonly outcome: GameOutcome | null; // set exactly once, only in "finished"
  // Task 14 settlement/early-decision bookkeeping. All null while playing.
  readonly adhesion: Adhesion | null;
  readonly settleCutoffSeq: number | null; // posts with seq <= this are settleable
  readonly settleDeadlineAtMs: number | null; // hard end of the settle window
  readonly endCause: EndCause | null;
  // TURN bookkeeping: the player who posted in the current turn. The reducer
  // clears it on every advance, so in reducer-produced states it is always
  // null; it exists to make the one-post-per-turn rule enforceable on
  // hand-constructed states too.
  readonly turnPosterId: PlayerId | null;
}
