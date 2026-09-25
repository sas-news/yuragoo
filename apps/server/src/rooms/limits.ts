// Room resource caps (Task 21): the contract bounds one room to 8MiB of
// content (original text + events + pose), 20 finished games and 12 hours
// of continuous lifetime. Caps are enforced ONLY at start-of-game
// boundaries (startGame / rematch / createRoom) — hitting one refuses the
// NEXT game and steers the host to closeRoom; existing content is never
// silently truncated and a running game is never killed.
//
// Accounting: content bytes are measured with SQLite LENGTH sums over the
// persisted snapshot (which carries every post's original text), the
// events payloads and the ending panel/pose — conservative, since it also
// counts structural JSON overhead. The finished-game counter lives in
// room_lifetime (bumped once per settle inside commitAction); the room's
// birth is the earliest of room_auth.created_at_ms (invite init) and
// room_meta.created_at_ms (first game create).
import type { ServerBindings } from "../config";
import { RoomError } from "./api";

export interface RoomLimits {
  readonly maxContentBytes: number;
  readonly maxGames: number;
  readonly maxLifetimeMs: number;
}

// Contract defaults (room contract: 8MiB / 20 games / 12h).
export const ROOM_CONTENT_CAP_BYTES = 8 * 1024 * 1024;
export const ROOM_GAMES_CAP = 20;
export const ROOM_LIFETIME_CAP_MS = 12 * 60 * 60 * 1000;

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

// Test seam — same pattern as injectDecisionJobDeps: a partial override
// applied on top of env+defaults, resolved per check so a test can change
// caps mid-flight.
let injectedLimits: Partial<RoomLimits> | null = null;
export const injectRoomLimitsForTest = (limits: Partial<RoomLimits> | null): void => {
  injectedLimits = limits;
};

export const resolveLimits = (env: ServerBindings): RoomLimits => ({
  maxContentBytes:
    injectedLimits?.maxContentBytes ??
    positiveInt(env.ROOM_MAX_CONTENT_BYTES, ROOM_CONTENT_CAP_BYTES),
  maxGames: injectedLimits?.maxGames ?? positiveInt(env.ROOM_MAX_GAMES, ROOM_GAMES_CAP),
  maxLifetimeMs:
    injectedLimits?.maxLifetimeMs ?? positiveInt(env.ROOM_MAX_LIFETIME_MS, ROOM_LIFETIME_CAP_MS),
});

// Content bytes = snapshot (original text lives inside it) + every events
// payload + the ending panel/pose. NULL-safe: each table contributes 0
// while absent/empty.
export const contentBytes = (sql: SqlStorage): number =>
  sql
    .exec<{ n: number | null }>(
      "SELECT COALESCE((" +
        "SELECT LENGTH(snapshot) + LENGTH(settings) FROM room_meta WHERE id = 1" +
        "), 0) + COALESCE((SELECT SUM(LENGTH(payload)) FROM events), 0) + COALESCE((" +
        "SELECT LENGTH(panel) + LENGTH(pose) FROM ending WHERE id = 1" +
        "), 0) AS n",
    )
    .one().n ?? 0;

// Games that reached "finished" for ANY outcome — the cap is a resource
// bound, not a stat, so noContest games count too (the public aggregate
// excludes them separately).
export const gamesFinished = (sql: SqlStorage): number =>
  sql
    .exec<{ n: number }>(
      "SELECT COALESCE((SELECT games_finished FROM room_lifetime WHERE id = 1), 0) AS n",
    )
    .one().n;

export const bumpGamesFinished = (sql: SqlStorage): void => {
  sql.exec(
    "INSERT INTO room_lifetime (id, games_finished, evaluation) VALUES (1, 1, 0) " +
      "ON CONFLICT(id) DO UPDATE SET games_finished = games_finished + 1",
  );
};

// Dev/eval flag: rooms created with CreateRoomInit.evaluation submit no
// public aggregates. Persisted room-wide so a rematch keeps it.
export const markEvaluationRoom = (sql: SqlStorage): void => {
  sql.exec(
    "INSERT INTO room_lifetime (id, games_finished, evaluation) VALUES (1, 0, 1) " +
      "ON CONFLICT(id) DO UPDATE SET evaluation = 1",
  );
};

export const isEvaluationRoom = (sql: SqlStorage): boolean =>
  sql
    .exec<{ n: number }>(
      "SELECT COALESCE((SELECT evaluation FROM room_lifetime WHERE id = 1), 0) AS n",
    )
    .one().n !== 0;

// Room birth = earliest recorded creation timestamp (invite init or first
// game create). null when the room was never initialized.
export const roomCreatedAtMs = (sql: SqlStorage): number | null =>
  sql
    .exec<{ n: number | null }>(
      "SELECT MIN(created_at_ms) AS n FROM (" +
        "SELECT created_at_ms FROM room_auth WHERE id = 1 " +
        "UNION ALL SELECT created_at_ms FROM room_meta WHERE id = 1)",
    )
    .one().n;

// The start-of-game gate. Throws RoomError with a stable cap code and a
// message steering the host to close — per contract the refusal must
// explain that the room itself is done, not that the command was bad.
export const assertGameStartAllowed = (
  sql: SqlStorage,
  limits: RoomLimits,
  nowMs: number,
): void => {
  if (contentBytes(sql) > limits.maxContentBytes) {
    throw new RoomError(
      "room-cap-content",
      "room content reached the size limit; close this room and open a new one",
    );
  }
  if (gamesFinished(sql) >= limits.maxGames) {
    throw new RoomError(
      "room-cap-games",
      "this room already played its maximum games; close it and open a new one",
    );
  }
  const created = roomCreatedAtMs(sql);
  if (created !== null && nowMs - created >= limits.maxLifetimeMs) {
    throw new RoomError(
      "room-cap-lifetime",
      "this room reached its lifetime limit; close it and open a new one",
    );
  }
};
