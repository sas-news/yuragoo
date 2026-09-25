// Client-command execution (Task 19). Every command rides the apply()
// ledger path — dedupe lookup then commit inside transactionSync — so a
// WS command and an RPC call never double-commit. The stored ApplyResult
// replays same-payload retries; identity comes from the attachment.
// The commit-side helpers live in ./commits (size cap).
import type { ClientEnvelope, ServerEnvelope } from "@yuragoo/protocol";
import { listRoomPlayers } from "./auth-storage";
import { executePlan, replayedAck } from "./commits";
import { planFor } from "./dispatch";
import type { ChoiceGenRequest } from "./generate-choices";
import type { Books } from "./due";
import { displayHostId } from "./host-election";
import type { RoomLimits } from "./limits";
import { readLobby } from "./lobby";
import type { DedupeKey } from "./storage";
import { ackFrame, fingerprintOf, snapshotFrame, type WireHost } from "./wire";

// Re-exported so transport/auth-rpc keep importing one module.
export { replayedAck } from "./commits";

// The DO surface command dispatch needs; GameRoom implements it.
export interface CommandHost extends WireHost {
  readonly sql: SqlStorage;
  txn<T>(fn: () => T): T;
  booksView(): Books | null;
  setBooks(books: Books | null): void;
  rearm(): Promise<void>;
  leaseMs(): number;
  // Task 24: the leave plan arms the empty-grace clock when the last
  // member walks out — same value SocketHost already exposes.
  emptyGraceMs(): number;
  // Task 21: room resource caps, resolved per command.
  roomLimits(): RoomLimits;
  // Task 21/22: best-effort ControlPlane active-room bookkeeping — every
  // path that starts a game registers the mapping close later revokes.
  registerRoom(): void;
  // Task 25: kick the async choice-generation attempt (fire-and-forget;
  // the provider call rides ctx.waitUntil inside the implementation).
  startChoiceGeneration(request: ChoiceGenRequest): void;
}

export interface CommandOutcome {
  readonly ack: ServerEnvelope | null; // sender only
  readonly events: readonly ServerEnvelope[]; // broadcast to every socket
  readonly reply: ServerEnvelope | null; // sender only, non-ack (snapshot)
  readonly committed: boolean; // books changed -> caller rearms the alarm
  readonly closeRoom: boolean; // caller tears the room down after sends
  // Task 24: sockets belonging to these players close after the ack and
  // the broadcast land — the `leave` command's post-deliver cleanup.
  readonly dropPlayerIds: readonly string[];
}

export const runClientCommand = (
  host: CommandHost,
  playerId: string,
  env: ClientEnvelope,
): CommandOutcome => {
  // syncRequest never dedupes: its whole job is returning a fresh snapshot.
  if (env.type === "syncRequest") {
    const snap = snapshotFrame(
      host,
      host.booksView(),
      listRoomPlayers(host.sql),
      displayHostId(host.sql),
      readLobby(host.sql),
    );
    return {
      ack: null,
      events: [],
      reply: snap,
      committed: false,
      closeRoom: false,
      dropPlayerIds: [],
    };
  }
  // Heartbeats are idempotent — skipping dedupe keeps the table small.
  const dedupe: DedupeKey | null =
    env.type === "heartbeat"
      ? null
      : { playerId, commandId: env.commandId, fingerprint: fingerprintOf(env) };
  const stored = dedupe && replayedAck(host, playerId, env.commandId, dedupe.fingerprint);
  if (stored !== null) {
    const ack = ackFrame(host, env.commandId, stored);
    return { ack, events: [], reply: null, committed: false, closeRoom: false, dropPlayerIds: [] };
  }
  const players = listRoomPlayers(host.sql);
  const plan = planFor({
    sql: host.sql,
    books: host.booksView(),
    players,
    playerId,
    env,
    leaseMs: host.leaseMs(),
    limits: host.roomLimits(),
  });
  const done = executePlan(host, plan, dedupe);
  return {
    ack: ackFrame(host, env.commandId, done.result),
    events: done.events,
    reply: null,
    committed: done.committed,
    closeRoom: done.closeRoom,
    dropPlayerIds: done.dropPlayerIds,
  };
};
