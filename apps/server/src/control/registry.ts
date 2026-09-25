// Active-room registry rows (Task 22): the ControlPlane's `rooms` table
// maps a live roomId to its creation/expiry timestamps and a revoked flag.
// Task 21 consumes this mapping for room teardown and Discord instance
// joins; Task 22 only maintains it. Rooms register best-effort at create
// and are revoked on close — rows are never deleted by these helpers so a
// revoked room keeps its tombstone for audit.
type RoomSqlRow = {
  room_id: string;
  created_at_ms: number;
  expires_at_ms: number;
  revoked: number;
};

export interface RoomRegistration {
  readonly roomId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly revoked: boolean;
}

// Contract: a room lives at most 12 hours (room resource bound); the
// registry keeps the same outer bound so a lost room can never stay
// "active" forever.
export const ROOM_REGISTRY_TTL_MS = 12 * 60 * 60 * 1000;

const toRegistration = (r: RoomSqlRow): RoomRegistration => ({
  roomId: r.room_id,
  createdAtMs: r.created_at_ms,
  expiresAtMs: r.expires_at_ms,
  revoked: r.revoked !== 0,
});

export const registerRoomRow = (
  sql: SqlStorage,
  roomId: string,
  createdAtMs: number,
  expiresAtMs: number,
): void => {
  sql.exec(
    "INSERT INTO rooms (room_id, created_at_ms, expires_at_ms, revoked) " +
      "VALUES (?, ?, ?, 0) " +
      "ON CONFLICT(room_id) DO UPDATE SET " +
      "created_at_ms = excluded.created_at_ms, expires_at_ms = excluded.expires_at_ms " +
      // revoked is deliberately NOT refreshed: a revoked room is closed
      // forever, so a late/arbitrary re-register can never resurrect it.
      "WHERE rooms.revoked = 0",
    roomId,
    createdAtMs,
    expiresAtMs,
  );
};

export const revokeRoomRow = (sql: SqlStorage, roomId: string): boolean =>
  sql.exec("UPDATE rooms SET revoked = 1 WHERE room_id = ?", roomId).rowsWritten > 0;

export const findRoomRow = (sql: SqlStorage, roomId: string): RoomRegistration | null => {
  const row = sql
    .exec<RoomSqlRow>(
      "SELECT room_id, created_at_ms, expires_at_ms, revoked FROM rooms WHERE room_id = ?",
      roomId,
    )
    .toArray()[0];
  return row === undefined ? null : toRegistration(row);
};

export const listRoomRows = (sql: SqlStorage): RoomRegistration[] =>
  sql
    .exec<RoomSqlRow>(
      "SELECT room_id, created_at_ms, expires_at_ms, revoked FROM rooms ORDER BY created_at_ms",
    )
    .toArray()
    .map(toRegistration);

// Lazily tombstone rooms whose expiry has passed — the expiry bound keeps
// the mapping honest even if a room's close callback never arrives.
export const expireRoomRows = (sql: SqlStorage, nowMs: number): number =>
  sql.exec("UPDATE rooms SET revoked = 1 WHERE revoked = 0 AND expires_at_ms <= ?", nowMs)
    .rowsWritten;
