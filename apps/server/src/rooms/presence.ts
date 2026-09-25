// Presence bookkeeping (Task 20): who is connected, the empty-room clock
// and the commit epilogue that broadcasts the resulting ledger events.
// "Connected" means a live heartbeat lease (lease_until_ms > now); a clean
// close clears it immediately, a silent drop is cleared by the lease
// sweep. Every mutation rides the caller's transactionSync, and every
// observable change is a persisted events-table row so the client stream
// stays gap-free — commitPresence then replays those new rows as frames.
import { RoomError } from "./api";
import { findRoomPlayer, writeLease } from "./auth-storage";
import { deleteDeadlineIds, replaceDeadline } from "./deadlines";
import type { Books } from "./due";
import { applyHostElection } from "./host-election";
import {
  connectedPlayerIds,
  expiredLeasePlayerIds,
  LEASE_SWEEP_TAG,
  pausePlayingDeadlines,
  readPresence,
  rearmLeaseSweep,
  resumePlayingDeadlines,
  ROOM_EXPIRY_TAG,
  writePresence,
} from "./leases";
import { maxEventSeq, recordRoomEvent } from "./storage";
import { attachmentOf, broadcastNewEvents, type SocketAttachment, type WireHost } from "./wire";

// The DO surface presence needs; GameRoom satisfies it via SocketHost.
export interface PresenceHost extends WireHost {
  readonly sql: SqlStorage;
  txn<T>(fn: () => T): T;
  booksView(): Books | null;
  setBooks(books: Books): void;
  sockets(): readonly WebSocket[];
  leaseMs(): number;
  emptyGraceMs(): number;
  rearm(): Promise<void>;
  waitUntil(p: Promise<void>): void;
}

export interface PresenceOutcome {
  // Players whose sockets should be closed after the commit (swept).
  readonly expiredIds: readonly string[];
  // Replacement books when the host election rewrote settings.hostId.
  readonly books: Books | null;
  readonly hostPlayerId: string | null;
  // Highest events-table seq this commit wrote (null = no room events) —
  // the caller re-syncs meta.stateRevision to it.
  readonly lastEventSeq: number | null;
}

const NONE: PresenceOutcome = {
  expiredIds: [],
  books: null,
  hostPlayerId: null,
  lastEventSeq: null,
};

class Acc {
  expiredIds: string[] = [];
  books: Books | null = null;
  host: string | null = null;
  lastSeq: number | null = null;
  saw(seq: number | null): void {
    if (seq !== null) this.lastSeq = seq;
  }
  done(): PresenceOutcome {
    return {
      expiredIds: this.expiredIds,
      books: this.books,
      hostPlayerId: this.host,
      lastEventSeq: this.lastSeq,
    };
  }
}

// Shared tail of every disconnect: presence event, host election when the
// room still has connections, and the empty-room bookkeeping when it does
// not (emptySince + optional playing-phase pause + expiry arming).
const markDisconnected = (host: PresenceHost, playerId: string, nowMs: number, acc: Acc): void => {
  writeLease(host.sql, playerId, null);
  acc.saw(recordRoomEvent(host.sql, "presenceChanged", { playerId, connected: false }));
  const connected = connectedPlayerIds(host.sql, nowMs).size;
  if (connected === 0) {
    const presence = readPresence(host.sql);
    const pause = host.booksView()?.state.phase === "playing";
    writePresence(host.sql, {
      ...presence,
      emptySinceMs: nowMs,
      pausedAtMs: pause ? nowMs : null,
    });
    if (pause) pausePlayingDeadlines(host.sql, nowMs);
    // Nobody left to detect: the sweep row is pointless, the grace clock
    // is the only alarm the room still needs.
    deleteDeadlineIds(host.sql, [LEASE_SWEEP_TAG]);
    replaceDeadline(host.sql, ROOM_EXPIRY_TAG, nowMs + host.emptyGraceMs(), ROOM_EXPIRY_TAG);
    acc.host = presence.hostPlayerId;
    return;
  }
  rearmLeaseSweep(host.sql);
  const el = applyHostElection(host.sql, acc.books ?? host.booksView(), nowMs);
  if (el.books !== null) acc.books = el.books;
  acc.saw(el.eventSeq);
  acc.host = el.hostPlayerId;
};

// Socket-close path. The generation guard is authoritative: a replaced
// socket's late close event must never clear the newer socket's presence.
export const disconnect = (
  host: PresenceHost,
  attachment: SocketAttachment,
  nowMs: number,
): PresenceOutcome => {
  const player = findRoomPlayer(host.sql, attachment.playerId);
  if (player === null || player.socketGeneration !== attachment.socketGeneration) return NONE;
  if (player.leaseUntilMs === null) return NONE; // already swept — idempotent
  const acc = new Acc();
  markDisconnected(host, attachment.playerId, nowMs, acc);
  return acc.done();
};

// Lease-sweep path: every player whose lease lapsed is dropped exactly
// like a disconnect, then their (dead) sockets get closed by the caller.
export const sweepExpiredLeases = (host: PresenceHost, nowMs: number): PresenceOutcome => {
  const acc = new Acc();
  for (const playerId of expiredLeasePlayerIds(host.sql, nowMs)) {
    acc.expiredIds.push(playerId);
    markDisconnected(host, playerId, nowMs, acc);
  }
  // Nothing may have lapsed (a heartbeat refreshed after the row armed):
  // always re-point the sweep row at the earliest live lease so the alarm
  // keeps covering silent drops.
  rearmLeaseSweep(host.sql);
  return acc.done();
};

// Admission path: resume the empty-room bookkeeping (parked clocks shift
// by the paused duration), grant the new lease and re-elect the host if
// the named host is not connected. Runs inside the caller's transaction.
export const admit = (host: PresenceHost, playerId: string, nowMs: number): PresenceOutcome => {
  const presence = readPresence(host.sql);
  if (presence.expired) {
    throw new RoomError("room-expired", "the room's empty grace window has passed");
  }
  const player = findRoomPlayer(host.sql, playerId);
  const wasConnected =
    player !== null && player.leaseUntilMs !== null && player.leaseUntilMs > nowMs;
  if (presence.pausedAtMs !== null) resumePlayingDeadlines(host.sql, nowMs);
  if (presence.emptySinceMs !== null || presence.pausedAtMs !== null) {
    writePresence(host.sql, { ...presence, emptySinceMs: null, pausedAtMs: null });
    deleteDeadlineIds(host.sql, [ROOM_EXPIRY_TAG]);
  }
  writeLease(host.sql, playerId, nowMs + host.leaseMs());
  rearmLeaseSweep(host.sql);
  let lastSeq: number | null = null;
  if (!wasConnected) {
    lastSeq = recordRoomEvent(host.sql, "presenceChanged", { playerId, connected: true });
  }
  const el = applyHostElection(host.sql, host.booksView(), nowMs);
  if (el.eventSeq !== null) lastSeq = el.eventSeq;
  return { expiredIds: [], books: el.books, hostPlayerId: el.hostPlayerId, lastEventSeq: lastSeq };
};

// Expired guard for every read/join/command entrypoint — also correct when
// the expiry alarm is late or was never delivered. Crossing the grace
// boundary lazily persists room_presence.expired AND re-arms the expiry
// deadline row at `now` — the armed row is what turns the mark into the
// actual purge (alarm.ts), so the delete can never be lost with the mark.
export const assertNotExpired = (host: PresenceHost, nowMs: number): void => {
  const p = readPresence(host.sql);
  if (p.expired) {
    throw new RoomError("room-expired", "the room's empty grace window has passed");
  }
  if (p.emptySinceMs !== null && nowMs - p.emptySinceMs > host.emptyGraceMs()) {
    writePresence(host.sql, { ...p, expired: true });
    replaceDeadline(host.sql, ROOM_EXPIRY_TAG, nowMs, ROOM_EXPIRY_TAG);
    throw new RoomError("room-expired", "the room's empty grace window has passed");
  }
};

// Marks the room expired from the room-expiry deadline row (alarm path).
export const markExpired = (host: PresenceHost): void => {
  const p = readPresence(host.sql);
  writePresence(host.sql, { ...p, expired: true });
};

// Shared commit epilogue for every presence mutation: one transactionSync,
// the optional in-memory books swap, the broadcast of the just-persisted
// event rows (gap-free ordering for every connected client), closes for
// swept sockets, and the alarm re-arm.
export const commitPresence = (
  host: PresenceHost,
  op: (host: PresenceHost) => PresenceOutcome,
  afterCommit?: (outcome: PresenceOutcome) => void,
): PresenceOutcome => {
  const since = maxEventSeq(host.sql);
  const out = host.txn(() => op(host));
  // When room events were persisted, meta.state_revision advanced past the
  // in-memory copy — re-sync it to exactly what this commit wrote (the
  // election's books swap rides along) so the next commitAction never
  // allocates an existing events.seq. A commit with no room events must
  // NOT re-sync: the table's head may exceed meta for unrelated reasons.
  const effective = out.books ?? host.booksView();
  if (effective !== null && (out.books !== null || out.lastEventSeq !== null)) {
    host.setBooks({
      meta: { ...effective.meta, stateRevision: out.lastEventSeq ?? effective.meta.stateRevision },
      state: effective.state,
    });
  }
  afterCommit?.(out);
  broadcastNewEvents(host, since, effective?.state ?? null);
  if (out.expiredIds.length > 0) closePlayerSockets(host, out.expiredIds);
  host.waitUntil(host.rearm());
  return out;
};

const closePlayerSockets = (host: PresenceHost, playerIds: readonly string[]): void => {
  const ids = new Set(playerIds);
  for (const ws of host.sockets()) {
    const att = attachmentOf(ws);
    if (att !== null && ids.has(att.playerId)) {
      try {
        ws.close(1000, "lease-expired");
      } catch {
        // Already closing.
      }
    }
  }
};
