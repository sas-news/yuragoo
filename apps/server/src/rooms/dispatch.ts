// Client-envelope -> execution-plan mapping (Task 19). Pure decisions only:
// given the envelope, the connection's playerId and the current books, pick
// what commit path (if any) runs. commands.ts executes the plan atomically.
//
//   submitText       -> game-core `post` as the connection player
//   pass             -> `deadline-reached` at the turn's own deadline, but
//                       only from the current turn player in TURN mode —
//                       identical to the turn clock firing on schedule
//   startGame        -> host-only create+start when no game exists
//   updateLobby      -> host-only settings patch; a real change clears
//                       every ready flag and broadcasts the shared view
//   requestDecision  -> `request-end`; the reducer enforces hostId and the
//                       hostDecision flag
//   rematch          -> finished-game create+start at epoch+1
//   closeRoom        -> host-only roomClosed broadcast + teardown
//   heartbeat        -> lease touch (45s window); no state change
//   syncRequest      -> handled by transport (snapshot reply), never here
import type { GameAction, GameSettings } from "@yuragoo/game-core";
import { currentTurnPlayer } from "@yuragoo/game-core";
import type { ClientEnvelope, LobbySettings, UpdateLobbyContentPayload } from "@yuragoo/protocol";
import { type RoomPlayer, writeLease } from "./auth-storage";
import type { Books } from "./due";
import { type ChoiceGenRequest, planChoiceGeneration } from "./generate-choices";
import { playerIsConnected } from "./host-election";
import { readPresence, rearmLeaseSweep } from "./leases";
import { assertGameStartAllowed, type RoomLimits } from "./limits";
import { assertLobbyStartable } from "./lobby";
import { assertStartPayloadVisible, resolveCreateSettings } from "./settings";
import { CommandError } from "./wire";

export type Plan =
  | { readonly kind: "action"; readonly action: GameAction }
  | {
      readonly kind: "create-start";
      readonly settings: GameSettings;
      readonly playerIds: readonly string[];
    }
  | { readonly kind: "rematch" }
  | { readonly kind: "ack-only"; readonly write: (sql: SqlStorage) => void }
  | { readonly kind: "close" }
  // Task 24 lobby ledger plans — pre-game only (the game locks them).
  | { readonly kind: "lobby-content"; readonly payload: UpdateLobbyContentPayload }
  | { readonly kind: "lobby-ready"; readonly playerId: string; readonly ready: boolean }
  | { readonly kind: "leave"; readonly playerId: string }
  // finished -> reopen the shared lobby (any member); the game ledger dies.
  | { readonly kind: "back-to-lobby" }
  // Host-only explicit hand-off to a connected member.
  | { readonly kind: "transfer-host"; readonly targetId: string }
  // Task 25: host-only one-shot AI generation request.
  | { readonly kind: "generate-choices"; readonly request: ChoiceGenRequest }
  // Task 26: host-only settings patch — lands through the lobby executor
  // so the merge, the ready-clear and the broadcast commit atomically.
  | { readonly kind: "lobby-settings"; readonly payload: LobbySettings };

// The room's effective host is the persisted election result (Task 20):
// authority follows the connected player the ledger names, so a returned
// old host keeps no claim and a bare invite holder never had one.
export const hostPlayerId = (sql: SqlStorage): string | null => readPresence(sql).hostPlayerId;

const requireHost = (sql: SqlStorage, playerId: string): void => {
  if (hostPlayerId(sql) !== playerId) {
    throw new CommandError("not-host", "only the current host may do that");
  }
};

const requireGame = (books: Books | null): Books => {
  if (books === null) throw new CommandError("not-created", "no game exists in this room yet");
  return books;
};

const passAction = (state: Books["state"], playerId: string): GameAction => {
  if (state.phase !== "playing") {
    throw new CommandError("not-playing", "pass requires the playing phase");
  }
  if (state.settings.mode !== "turn") {
    throw new CommandError("bad-state", "pass is only available in turn mode");
  }
  if (currentTurnPlayer(state) !== playerId) {
    throw new CommandError("not-your-turn", "only the current turn player may pass");
  }
  // Real wall clock: a voluntary pass ends the turn now. Stamping the
  // scheduled deadline here would let rapid passing push the game's clock
  // (and eventually the settle window) arbitrarily far into the future.
  return { type: "pass", playerId, nowMs: Date.now() };
};

export interface PlanInput {
  readonly sql: SqlStorage;
  readonly books: Books | null;
  readonly players: readonly RoomPlayer[];
  readonly playerId: string;
  readonly env: ClientEnvelope;
  readonly leaseMs: number;
  // Task 21: the resolved room resource caps — start-of-game boundaries
  // (startGame/rematch) refuse once the room is exhausted.
  readonly limits: RoomLimits;
}

export const planFor = ({
  sql,
  books,
  players,
  playerId,
  env,
  leaseMs,
  limits,
}: PlanInput): Plan => {
  switch (env.type) {
    case "heartbeat": {
      const until = Date.now() + leaseMs;
      // The lease write and the sweep-row re-arm commit together so the
      // room's single alarm always covers the earliest live lease.
      return {
        kind: "ack-only",
        write: (s) => {
          writeLease(s, playerId, until);
          rearmLeaseSweep(s);
        },
      };
    }
    case "updateLobby": {
      // Task 26: host-only, pre-game only. The settings merge + ready
      // reset + lobbyChanged broadcast land atomically in the commit.
      requireHost(sql, playerId);
      if (books !== null) {
        throw new CommandError("bad-state", "lobby settings can only change before the game");
      }
      return { kind: "lobby-settings", payload: env.payload };
    }
    case "startGame": {
      requireHost(sql, playerId);
      if (books !== null) {
        throw new CommandError("already-started", "this room already has a game");
      }
      // Room resource cap: refuse the next game start and steer to close.
      assertGameStartAllowed(sql, limits, Date.now());
      // Task 26: the game starts with exactly the settings everyone saw —
      // a payload display field may confirm the view, never change it.
      assertStartPayloadVisible(sql, env.payload);
      // Task 24 lobby gate (server-authoritative): >=2 non-lobbyWaiting
      // members, everyone ready, scenario non-empty and the committed
      // choice prefix filled with distinct labels. The returned member
      // list — not the raw room ledger — becomes the game roster.
      const members = assertLobbyStartable(sql, players);
      const playerIds = members.map((p) => p.playerId);
      return {
        kind: "create-start",
        settings: resolveCreateSettings(sql, env.payload, playerIds.length, playerId),
        playerIds,
      };
    }
    case "updateLobbyContent": {
      requireHost(sql, playerId);
      if (books !== null) {
        throw new CommandError("bad-state", "the lobby content is locked once the game starts");
      }
      return { kind: "lobby-content", payload: env.payload };
    }
    case "setReady": {
      if (books !== null) {
        throw new CommandError("bad-state", "the lobby is locked once the game starts");
      }
      if (!players.some((p) => p.playerId === playerId)) {
        throw new CommandError("not-a-member", "only room members may ready up");
      }
      return { kind: "lobby-ready", playerId, ready: env.payload.ready };
    }
    case "generateChoices":
      // Task 25: click-only, host-only, pre-game only. Every gate runs
      // free inside planChoiceGeneration; the slot/grant are spent only
      // by the async runner after this command commits.
      return {
        kind: "generate-choices",
        request: planChoiceGeneration(sql, players, playerId, books !== null, env.commandId),
      };
    case "leave": {
      const me = players.find((p) => p.playerId === playerId);
      if (me === undefined) {
        throw new CommandError("not-a-member", "only room members may leave");
      }
      // A roster member cannot walk out mid-game (their slot is live);
      // a lobby-waiting joiner can — they never entered the roster — and
      // anyone can once the game is finished (leaving re-elects the host).
      if (books !== null && books.state.phase !== "finished" && !me.lobbyWaiting) {
        throw new CommandError("bad-state", "roster members cannot leave a game in progress");
      }
      return { kind: "leave", playerId };
    }
    case "rematch": {
      const b = requireGame(books);
      if (b.state.phase !== "finished") {
        throw new CommandError("bad-state", "rematch requires a finished game");
      }
      // Same boundary as startGame — a rematch is the next game.
      assertGameStartAllowed(sql, limits, Date.now());
      return { kind: "rematch" };
    }
    case "backToLobby": {
      const b = requireGame(books);
      if (b.state.phase !== "finished") {
        throw new CommandError("bad-state", "backToLobby requires a finished game");
      }
      if (!players.some((p) => p.playerId === playerId)) {
        throw new CommandError("not-a-member", "only room members may reopen the lobby");
      }
      return { kind: "back-to-lobby" };
    }
    case "transferHost": {
      requireHost(sql, playerId);
      const target = players.find((p) => p.playerId === env.payload.playerId);
      if (target === undefined || target.playerId === playerId) {
        throw new CommandError("not-a-member", "transfer needs another room member");
      }
      if (!playerIsConnected(sql, target.playerId, Date.now())) {
        throw new CommandError("bad-state", "the target member is offline");
      }
      return { kind: "transfer-host", targetId: target.playerId };
    }
    case "closeRoom": {
      requireHost(sql, playerId);
      return { kind: "close" };
    }
    case "submitText":
      requireGame(books);
      return {
        kind: "action",
        action: {
          type: "post",
          playerId,
          text: env.payload.text,
          nowMs: Date.now(),
        },
      };
    case "pass":
      return { kind: "action", action: passAction(requireGame(books).state, playerId) };
    case "requestDecision":
      requireGame(books);
      return {
        kind: "action",
        action: { type: "request-end", playerId, nowMs: Date.now() },
      };
    case "syncRequest":
      throw new CommandError("internal", "syncRequest is handled before dispatch");
  }
};
