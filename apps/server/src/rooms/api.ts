// Public RPC contract of the GameRoom Durable Object — the boundary the
// Worker routes (../auth/browser.ts) call. Types live apart from
// GameRoom.ts so the class file stays under the handwritten-size cap;
// GameRoom re-exports them for existing importers.
import type { GameAction, GameSettings, GameState } from "@yuragoo/game-core";
import type { Deadline } from "./deadlines";
import type { Books } from "./due";
import type { ApplyResult } from "./storage";

export class RoomError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "RoomError";
    this.code = code;
  }
}

export interface CreateRoomInit {
  readonly settings: GameSettings;
  readonly playerIds: readonly string[];
  readonly nowMs: number;
  readonly platform?: string;
  // Optional invite hash stored alongside the game create; an existing
  // invite hash (written by initRoom) is never overwritten.
  readonly inviteSecretHash?: string;
  // Dev/eval rooms (eval harnesses, fixture rooms) opt out of the public
  // aggregates — their finished games never submit (room contract).
  readonly evaluation?: boolean;
}

export interface CreateRoomResult {
  readonly gameEpoch: number;
  readonly stateRevision: number;
  readonly events: ApplyResult["events"];
}

export interface ApplyInput {
  readonly playerId: string;
  readonly commandId: string;
  readonly action: GameAction;
  readonly fingerprint: string;
}

export interface RoomSnapshotView {
  readonly gameEpoch: number;
  readonly inputSeq: number;
  readonly stateRevision: number;
  readonly phase: string;
  readonly quota: { readonly jevAttempts: number; readonly generationAttempts: number };
  readonly deadlines: readonly Deadline[];
  readonly state: GameState;
}

export const buildSnapshotView = (
  books: Books,
  deadlines: readonly Deadline[],
): RoomSnapshotView => ({
  gameEpoch: books.meta.gameEpoch,
  inputSeq: books.meta.inputSeq,
  stateRevision: books.meta.stateRevision,
  phase: books.state.phase,
  quota: {
    jevAttempts: books.meta.jevAttempts,
    generationAttempts: books.meta.generationAttempts,
  },
  deadlines,
  state: books.state,
});

// --- room-auth RPC (Task 18) ----------------------------------------------
// All inputs carry HASHES of secrets, never the secrets themselves; raw
// tokens exist only inside result objects returned to the caller once.

export interface InitRoomInput {
  readonly inviteSecretHash: string;
  readonly platform: string;
  readonly nowMs: number;
}

export interface JoinRoomInput {
  readonly inviteSecretHash: string;
  readonly displayName: string | null;
  readonly platform: string;
  readonly nowMs: number;
}

export interface JoinRoomResult {
  readonly playerId: string;
  readonly sessionToken: string;
  readonly reconnectToken: string;
  readonly joinOrder: number;
  readonly lobbyWaiting: boolean;
}

export interface ReconnectInput {
  readonly reconnectTokenHash: string;
}

export interface ReconnectResult {
  readonly playerId: string;
  readonly sessionToken: string;
  readonly reconnectToken: string;
}

export interface IssueTicketInput {
  readonly sessionTokenHash: string;
  readonly nowMs: number;
}

export interface IssueTicketResult {
  readonly ticket: string;
  readonly expiresInSec: number;
}

export interface ConsumeTicketInput {
  readonly ticketHash: string;
  readonly nowMs: number;
}

export interface ConsumeTicketResult {
  readonly playerId: string;
  readonly socketGeneration: number;
}
