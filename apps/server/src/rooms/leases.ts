// Lease bookkeeping + empty-room pause/resume + expiry guard (Task 20).
// All functions are synchronous SQLite steps the caller composes inside
// ctx.storage.transactionSync — nothing here opens its own transaction.
//
// Two bookkeeping rows live in the `deadlines` table alongside the game
// clocks so the room's single alarm (= min(run_at)) also wakes for them:
//   lease-sweep -> fires at min(lease_until_ms); the handler drops every
//                  player whose heartbeat lease has lapsed, then re-arms.
//   room-expiry -> armed at emptySince + ROOM_EMPTY_GRACE_MS while the
//                  room is empty; the handler marks room_presence.expired.
// Pause works by MOVING playing-phase rows into paused_deadlines as
// remaining-time; a resume reinserts them shifted by the paused duration.
import { deleteDeadlineIds, replaceDeadline } from "./deadlines";

// The deadline tags frozen while the room is empty: playing-phase clocks
// only. settle / starting / generation rows are deliberately absent — they
// keep running while the room is unattended (room contract line 91).
export const PAUSABLE_TAGS = ["turn", "match", "dwell"] as const;

export const LEASE_SWEEP_TAG = "lease-sweep";
export const ROOM_EXPIRY_TAG = "room-expiry";
// Task 21 deadline tags: the outbox flush rides the room's single alarm;
// 'room-purge' is the armed delete that follows the expiry mark, and
// 'wipe-retry' re-attempts a failed deleteAll on a closed room.
export const OUTBOX_FLUSH_TAG = "outbox-flush";
export const ROOM_PURGE_TAG = "room-purge";
export const WIPE_RETRY_TAG = "wipe-retry";
export const ROOM_DEADLINE_TAGS = new Set<string>([
  LEASE_SWEEP_TAG,
  ROOM_EXPIRY_TAG,
  OUTBOX_FLUSH_TAG,
  ROOM_PURGE_TAG,
  WIPE_RETRY_TAG,
]);

export interface RoomPresenceRow {
  readonly hostPlayerId: string | null;
  readonly emptySinceMs: number | null;
  readonly pausedAtMs: number | null;
  readonly expired: boolean;
}

type PresenceSqlRow = {
  host_player_id: string | null;
  empty_since_ms: number | null;
  paused_at_ms: number | null;
  expired: number;
};

const EMPTY_PRESENCE: RoomPresenceRow = {
  hostPlayerId: null,
  emptySinceMs: null,
  pausedAtMs: null,
  expired: false,
};

export const readPresence = (sql: SqlStorage): RoomPresenceRow => {
  const row = sql
    .exec<PresenceSqlRow>(
      "SELECT host_player_id, empty_since_ms, paused_at_ms, expired FROM room_presence WHERE id = 1",
    )
    .toArray()[0];
  return row === undefined
    ? EMPTY_PRESENCE
    : {
        hostPlayerId: row.host_player_id,
        emptySinceMs: row.empty_since_ms,
        pausedAtMs: row.paused_at_ms,
        expired: row.expired !== 0,
      };
};

export const writePresence = (sql: SqlStorage, p: RoomPresenceRow): void => {
  sql.exec(
    "INSERT OR REPLACE INTO room_presence " +
      "(id, host_player_id, empty_since_ms, paused_at_ms, expired) VALUES (1, ?, ?, ?, ?)",
    p.hostPlayerId,
    p.emptySinceMs,
    p.pausedAtMs,
    p.expired ? 1 : 0,
  );
};

// Constructor-side expiry check (Task 21): a room already marked expired,
// or one whose empty-grace window elapsed while it was evicted, is purged
// on startup instead of lingering until the next alarm.
export const isRoomExpired = (sql: SqlStorage, emptyGraceMs: number, nowMs: number): boolean => {
  const p = readPresence(sql);
  return p.expired || (p.emptySinceMs !== null && nowMs - p.emptySinceMs > emptyGraceMs);
};

// --- lease bookkeeping -----------------------------------------------------

// Players considered connected right now: a live lease row. A socket with
// no close event still counts until its lease lapses (silent drop); a
// close writes NULL for immediate detection.
export const connectedPlayerIds = (sql: SqlStorage, nowMs: number): Set<string> =>
  new Set(
    sql
      .exec<{ player_id: string }>(
        "SELECT player_id FROM room_players WHERE lease_until_ms IS NOT NULL AND lease_until_ms > ?",
        nowMs,
      )
      .toArray()
      .map((r) => r.player_id),
  );

export const expiredLeasePlayerIds = (sql: SqlStorage, nowMs: number): string[] =>
  sql
    .exec<{ player_id: string }>(
      "SELECT player_id FROM room_players WHERE lease_until_ms IS NOT NULL AND lease_until_ms <= ?",
      nowMs,
    )
    .toArray()
    .map((r) => r.player_id);

// Re-point the lease-sweep deadline at the earliest live lease expiry;
// with no leases the row is removed (nothing left to detect).
export const rearmLeaseSweep = (sql: SqlStorage): void => {
  const min = sql
    .exec<{ m: number | null }>(
      "SELECT MIN(lease_until_ms) AS m FROM room_players WHERE lease_until_ms IS NOT NULL",
    )
    .one().m;
  if (min === null) deleteDeadlineIds(sql, [LEASE_SWEEP_TAG]);
  else replaceDeadline(sql, LEASE_SWEEP_TAG, min, LEASE_SWEEP_TAG);
};

// --- empty-room pause -------------------------------------------------------

// Park the playing-phase clocks as remaining-time rows. Settle /
// generation / lease-sweep / room-expiry rows stay armed untouched.
export const pausePlayingDeadlines = (sql: SqlStorage, nowMs: number): void => {
  const marks = PAUSABLE_TAGS.map(() => "?").join(", ");
  sql.exec(
    `INSERT OR REPLACE INTO paused_deadlines (id, remaining_ms, tag) ` +
      `SELECT id, run_at - ?, tag FROM deadlines WHERE tag IN (${marks})`,
    nowMs,
    ...PAUSABLE_TAGS,
  );
  sql.exec(`DELETE FROM deadlines WHERE tag IN (${marks})`, ...PAUSABLE_TAGS);
};

// Resume restores each parked clock at now + remaining — equivalent to
// shifting the original run_at by (now - pausedAt).
export const resumePlayingDeadlines = (sql: SqlStorage, nowMs: number): void => {
  sql.exec(
    "INSERT OR REPLACE INTO deadlines (id, run_at, tag) " +
      "SELECT id, ? + remaining_ms, tag FROM paused_deadlines",
    nowMs,
  );
  sql.exec("DELETE FROM paused_deadlines");
};
