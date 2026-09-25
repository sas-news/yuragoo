// GameRoom's game-ledger RPC bodies (Task 22 split them out of GameRoom.ts
// for size): createRoom, apply and retireRoom, plus the shared lazy lease
// sweep. Everything still commits through the same atomic paths — these
// functions only relocate the orchestration. Task 21: the create path now
// enforces the room resource caps, a finished commit kicks the aggregate
// outbox, and the teardown itself lives in ./close.
import * as api from "./api";
import { type CloseHost, retireRoom } from "./close";
import { replayedAck } from "./commands";
import type { ServerBindings } from "../config";
import { commitCreate } from "./create";
import type { Books } from "./due";
import { assertGameStartAllowed, type RoomLimits } from "./limits";
import * as presence from "./presence";
import { registerActiveRoom } from "./room-registry";
import { type ApplyResult, commitAction } from "./storage";

// The GameRoom surface the ledger RPCs need (CloseHost covers the Task-21
// teardown: sql/storage/sockets/setBooks/markClosed/isClosed/rearm).
export interface LedgerHost extends CloseHost {
  booksView(): Books | null;
  assertLive(): void;
  roomEpoch(): number;
  leaseMs(): number;
  emptyGraceMs(): number;
  waitUntil(p: Promise<void>): void;
  roomLimits(): RoomLimits;
  driveOutbox(): Promise<void>;
  driveEnding(): Promise<void>;
}

// The lazy half of lease enforcement (the alarm is the other): lapsed
// leases drop exactly like disconnects, with election + empty-room
// bookkeeping riding the same commit.
export const sweepLeases = (host: LedgerHost): void => {
  presence.commitPresence(host, (h) => presence.sweepExpiredLeases(h, Date.now()));
};

export const createRoomAt = async (
  host: LedgerHost,
  ctx: Pick<DurableObjectState, "waitUntil">,
  env: ServerBindings,
  init: api.CreateRoomInit,
): Promise<api.CreateRoomResult> => {
  host.assertLive();
  sweepLeases(host);
  if (host.booksView() !== null) {
    throw new api.RoomError("already-created", "room already has a game");
  }
  // Start-of-game boundary: the room resource caps refuse the next game
  // once content/games/lifetime are exhausted (never silently truncate).
  assertGameStartAllowed(host.sql, host.roomLimits(), init.nowMs);
  const committed = host.txn(() => commitCreate(host.sql, init));
  host.setBooks({ meta: committed.meta, state: committed.state });
  await host.rearm();
  registerActiveRoom(ctx, env, host.roomId);
  return {
    gameEpoch: committed.meta.gameEpoch,
    stateRevision: committed.result.stateRevision,
    events: committed.result.events,
  };
};

export const applyToRoom = async (
  host: LedgerHost,
  input: api.ApplyInput,
  drive: () => Promise<void>,
): Promise<ApplyResult> => {
  host.assertLive();
  sweepLeases(host);
  const books = host.booksView();
  if (books === null) throw new api.RoomError("not-created", "room is not created");
  // A direct `create` action is a start-of-game boundary too — the caps
  // apply to every path that can start a game, not just the WS command.
  if (input.action.type === "create") {
    assertGameStartAllowed(host.sql, host.roomLimits(), input.action.nowMs);
  }
  const stored = replayedAck(host, input.playerId, input.commandId, input.fingerprint);
  if (stored !== null) return stored;
  const committed = host.txn(() =>
    commitAction(host.sql, books.meta, books.state, input.action, input),
  );
  host.setBooks({ meta: committed.meta, state: committed.state });
  await host.rearm();
  // A finished game enqueued an aggregate outbox row — flush it without
  // blocking the ack (submission is server-only and best-effort).
  if (committed.state.phase === "finished") {
    host.waitUntil(host.driveOutbox());
    host.waitUntil(host.driveEnding());
  }
  // An accepted post wrote a pending evaluate job — drive it without
  // blocking the ack (the result arrives as a decisionUpdated event).
  host.waitUntil(drive());
  return committed.result;
};

// closeRoom teardown — the close sequence (registry revoke -> invalidate
// -> socket close -> deleteAll, with wipe-retry on failure) lives in
// ./close.ts.
export const retireRoomNow = async (
  host: LedgerHost,
  ctx: Pick<DurableObjectState, "waitUntil">,
  env: ServerBindings,
): Promise<void> => {
  await retireRoom(host, ctx, env);
};
