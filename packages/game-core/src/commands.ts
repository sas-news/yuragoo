// Commands are the ONLY way the rules talk to the outside world: reduce()
// returns them for the host runtime to execute (arm a deadline, schedule an
// AI evaluation, broadcast an event, record a final outcome). GameAction is
// the inbound union — every input a room can feed the reducer.
import type { GameOutcome, SettleClaim } from "./outcome";
import type { GameSettings } from "./settings";
import type { GameState, Player, PlayerId } from "./state";

export type GameEvent =
  | { readonly type: "started"; readonly roster: readonly Player[] }
  | { readonly type: "turn"; readonly round: number; readonly playerId: PlayerId }
  | { readonly type: "passed"; readonly playerId: PlayerId }
  | { readonly type: "posted"; readonly postId: string; readonly playerId: PlayerId }
  | { readonly type: "complete"; readonly cutoffSeq: number; readonly cause: string }
  | { readonly type: "end-requested"; readonly playerId: PlayerId }
  | { readonly type: "finished"; readonly outcome: GameOutcome };

export type GameCommand =
  | {
      readonly type: "set-deadline";
      readonly atMs: number;
      readonly tag: "turn" | "match" | "settle";
    }
  | { readonly type: "evaluate"; readonly postId: string; readonly seq: number }
  | { readonly type: "publish"; readonly event: GameEvent }
  | { readonly type: "finish"; readonly outcome: GameOutcome }
  // Defined now, emitted by nobody yet: room lifecycle is a later task and
  // host end-request (the request-end action) is deliberately different.
  | { readonly type: "close-room" };

// Result of applying one action: the next immutable state plus the ordered
// side effects the host must perform.
export interface GameTransition {
  readonly state: GameState;
  readonly commands: readonly GameCommand[];
}

export type GameAction =
  | {
      readonly type: "create";
      readonly settings: GameSettings;
      readonly playerIds: readonly string[];
      readonly nowMs: number;
    }
  | { readonly type: "start"; readonly nowMs: number }
  | {
      readonly type: "post";
      readonly playerId: string;
      readonly text: string;
      readonly nowMs: number;
    }
  | { readonly type: "deadline-reached"; readonly nowMs: number }
  // A voluntary turn pass ends the turn NOW (real nowMs) — unlike
  // deadline-reached it never anchors the next turn to the old schedule.
  | { readonly type: "pass"; readonly playerId: PlayerId; readonly nowMs: number }
  | { readonly type: "evaluated"; readonly postId: string } // marks a pending post evaluated
  | { readonly type: "abort" } // host/ops abort -> noContest
  // Task 14: early decision + settlement.
  | { readonly type: "adhere"; readonly slot: number; readonly nowMs: number }
  | { readonly type: "dwell-complete"; readonly nowMs: number }
  | { readonly type: "request-end"; readonly playerId: string; readonly nowMs: number }
  | { readonly type: "settle"; readonly nowMs: number; readonly claim: SettleClaim }
  | { readonly type: "settle-deadline"; readonly nowMs: number };
