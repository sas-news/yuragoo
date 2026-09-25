// Host election (Task 20). The room's effective host is persisted in
// room_presence.host_player_id and is sticky: it only changes when the
// current host is detected disconnected (close or lease expiry) or when a
// connection arrives while the named host is away. Election always picks
// the CONNECTED player with the smallest joinOrder (ties -> lexicographic
// playerId); a returning old host never takes the seat back. Holding only
// the invite link can never make you host — candidates need a live lease.
import { findRoomPlayer, listRoomPlayers, type RoomPlayer } from "./auth-storage";
import { connectedPlayerIds, readPresence, writePresence } from "./leases";
import { recordRoomEvent, writeMeta, type MetaRow } from "./storage";
import type { Books } from "./due";

export const electHostPlayerId = (
  players: readonly RoomPlayer[],
  connectedIds: ReadonlySet<string>,
): string | null => {
  let best: RoomPlayer | null = null;
  for (const p of players) {
    if (!connectedIds.has(p.playerId)) continue;
    if (
      best === null ||
      p.joinOrder < best.joinOrder ||
      (p.joinOrder === best.joinOrder && p.playerId < best.playerId)
    ) {
      best = p;
    }
  }
  return best?.playerId ?? null;
};

export interface HostElection {
  readonly hostPlayerId: string | null;
  readonly changed: boolean;
  // The events-table seq the hostChanged row was written at — callers
  // re-sync meta.stateRevision to it so game commits never collide.
  readonly eventSeq: number | null;
  // When a game exists and the new host sits in its roster, the snapshot's
  // settings.hostId is rewritten in the same commit so in-game host
  // authority (request-end) follows the room host. The caller applies the
  // books swap only after the transaction commits.
  readonly books: Books | null;
}

// Ensure the persisted host names a connected player. Emits a hostChanged
// ledger event (and snapshot rewrite) on an actual change; a no-candidate
// election (empty room) keeps the previous host so the last authority is
// remembered while everyone is away.
export const applyHostElection = (
  sql: SqlStorage,
  books: Books | null,
  nowMs: number,
): HostElection => {
  const players = listRoomPlayers(sql);
  const connected = connectedPlayerIds(sql, nowMs);
  const presence = readPresence(sql);
  const current = presence.hostPlayerId;
  if (current !== null && connected.has(current)) {
    return { hostPlayerId: current, changed: false, eventSeq: null, books: null };
  }
  const elected = electHostPlayerId(players, connected);
  if (elected === null) {
    return { hostPlayerId: current, changed: false, eventSeq: null, books: null };
  }
  writePresence(sql, { ...presence, hostPlayerId: elected });
  const seq = recordRoomEvent(sql, "hostChanged", { playerId: elected });
  return {
    hostPlayerId: elected,
    changed: true,
    eventSeq: seq,
    books: retargetGameHost(sql, books, elected),
  };
};

// Rewrite settings.hostId inside the persisted snapshot when the elected
// host is a roster member — a room-level authority change the reducer can
// never model (it knows nothing about sockets). lobbyWaiting members are
// deliberately skipped: they hold room powers but no in-game authority.
const retargetGameHost = (sql: SqlStorage, books: Books | null, hostId: string): Books | null => {
  if (books === null) return null;
  if (!books.state.roster.some((p) => p.id === hostId)) return null;
  if (books.state.settings.hostId === hostId) return null;
  const state = { ...books.state, settings: { ...books.state.settings, hostId } };
  const meta: MetaRow = {
    ...books.meta,
    snapshot: JSON.stringify(state),
    settings: JSON.stringify(state.settings),
  };
  writeMeta(sql, meta);
  return { meta, state };
};

// Explicit hand-off (transferHost command): the current host names the
// successor directly instead of electing by joinOrder. Same commit shape
// as an election — presence row + hostChanged ledger event + the in-game
// hostId retarget when the target sits in the roster.
export const applyHostTransfer = (
  sql: SqlStorage,
  books: Books | null,
  targetId: string,
): HostElection => {
  const presence = readPresence(sql);
  writePresence(sql, { ...presence, hostPlayerId: targetId });
  const seq = recordRoomEvent(sql, "hostChanged", { playerId: targetId });
  return {
    hostPlayerId: targetId,
    changed: true,
    eventSeq: seq,
    books: retargetGameHost(sql, books, targetId),
  };
};

// The host a client sees: the persisted election result, falling back to
// the lowest joinOrder when nobody ever connected (pre-game convenience —
// no host powers attach until a real election happens on admission).
export const displayHostId = (sql: SqlStorage): string | null => {
  const presence = readPresence(sql);
  if (presence.hostPlayerId !== null) return presence.hostPlayerId;
  return listRoomPlayers(sql)[0]?.playerId ?? null;
};

export const playerIsConnected = (sql: SqlStorage, playerId: string, nowMs: number): boolean => {
  const lease = findRoomPlayer(sql, playerId)?.leaseUntilMs ?? null;
  return lease !== null && lease > nowMs;
};
