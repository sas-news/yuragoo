// Member-drop policy layer over presence.ts. A lost connection releases
// the seat OUTRIGHT while the lobby is open (the row dies exactly like
// `leave` — memberLeft + ready strip + the choice draft moves to the
// orphan tail — so a departed player can never block the start gate).
// Mid-game the roster is sacred: the member only marks disconnected and
// may reconnect, then the reopen commit (lifecycle-commit) vacates any
// ghosts the moment the room becomes a lobby again.
import { deleteRoomPlayer, findRoomPlayer } from "./auth-storage";
import { expiredLeasePlayerIds, rearmLeaseSweep } from "./leases";
import { onMemberLeft } from "./lobby";
import {
  Acc,
  departed,
  markDisconnected,
  NONE,
  type PresenceHost,
  type PresenceOutcome,
} from "./presence";
import type { SocketAttachment } from "./wire";

// The member row dies with its tokens exactly like `leave` — the seat
// draft moves to the orphan tail and a fresh invite join is the only way
// back. onMemberLeft runs BEFORE the delete: the seat index comes from
// the leaver's join_order rank among active members.
export const vacateMember = (
  host: PresenceHost,
  playerId: string,
  nowMs: number,
  acc: Acc,
): void => {
  onMemberLeft(host.sql, playerId, host.booksView() !== null);
  deleteRoomPlayer(host.sql, playerId);
  departed(host, nowMs, acc);
};

// A member's connection is gone. Lobby: vacate immediately. In flight:
// plain disconnect — a reconnect keeps their seat until the lobby
// returns.
export const dropMember = (host: PresenceHost, playerId: string, nowMs: number, acc: Acc): void => {
  if (host.booksView() === null) {
    acc.expiredIds.push(playerId);
    vacateMember(host, playerId, nowMs, acc);
  } else {
    markDisconnected(host, playerId, nowMs, acc);
  }
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
  dropMember(host, attachment.playerId, nowMs, acc);
  return acc.done();
};

// Lease-sweep path: every player whose lease lapsed is dropped exactly
// like a socket close, then their (dead) sockets get closed by the caller.
export const sweepExpiredLeases = (host: PresenceHost, nowMs: number): PresenceOutcome => {
  const acc = new Acc();
  for (const playerId of expiredLeasePlayerIds(host.sql, nowMs)) {
    acc.expiredIds.push(playerId);
    dropMember(host, playerId, nowMs, acc);
  }
  // Nothing may have lapsed (a heartbeat refreshed after the row armed):
  // always re-point the sweep row at the earliest live lease so the alarm
  // keeps covering silent drops.
  rearmLeaseSweep(host.sql);
  return acc.done();
};
