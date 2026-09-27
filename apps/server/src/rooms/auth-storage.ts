// Auth persistence for the GameRoom Durable Object — the SQL row layer the
// auth domain code (../auth/*) composes inside transactionSync. room_auth
// is a single-row table holding the invite hash for the room's lifetime;
// room_players is the room membership ledger (join order, platform,
// lobby-waiting flag, socket generation, session/reconnect token HASHES —
// raw secrets are never stored). Every query uses bound params and every
// cursor is consumed inside the call.
type RoomAuthSqlRow = { invite_hash: string; platform: string; created_at_ms: number };

export interface RoomAuth {
  readonly inviteHash: string;
  readonly platform: string;
  readonly createdAtMs: number;
}

export const readRoomAuth = (sql: SqlStorage): RoomAuth | null => {
  const row = sql
    .exec<RoomAuthSqlRow>("SELECT invite_hash, platform, created_at_ms FROM room_auth WHERE id = 1")
    .toArray()[0];
  return row === undefined
    ? null
    : { inviteHash: row.invite_hash, platform: row.platform, createdAtMs: row.created_at_ms };
};

export const writeRoomAuth = (
  sql: SqlStorage,
  inviteHash: string,
  platform: string,
  nowMs: number,
): void => {
  sql.exec(
    "INSERT INTO room_auth (id, invite_hash, platform, created_at_ms) VALUES (1, ?, ?, ?)",
    inviteHash,
    platform,
    nowMs,
  );
};

// Used by the game-create path: keeps an invite hash the room already has.
export const ensureRoomAuth = (
  sql: SqlStorage,
  inviteHash: string,
  platform: string,
  nowMs: number,
): void => {
  if (readRoomAuth(sql) === null) writeRoomAuth(sql, inviteHash, platform, nowMs);
};

type RoomPlayerSqlRow = {
  player_id: string;
  join_order: number;
  display_name: string | null;
  platform: string;
  discord_user_id: string | null;
  avatar_url: string | null;
  session_hash: string;
  reconnect_hash: string;
  lobby_waiting: number;
  socket_generation: number;
  lease_until_ms: number | null;
  joined_at_ms: number;
};

export interface RoomPlayer {
  readonly playerId: string;
  readonly joinOrder: number;
  readonly displayName: string | null;
  readonly platform: string;
  // Task 35: the verified Discord user id owning this seat (NULL for
  // browser joins). Seat dedupe + the unique index key on room_players.
  readonly discordUserId: string | null;
  // CDN avatar URL resolved at join time (Discord seats only); NULL for
  // browser joins and avatar-less accounts.
  readonly avatarUrl: string | null;
  readonly sessionHash: string;
  readonly reconnectHash: string;
  readonly lobbyWaiting: boolean;
  readonly socketGeneration: number;
  readonly leaseUntilMs: number | null;
  readonly joinedAtMs: number;
}

const ROOM_PLAYER_COLUMNS =
  "player_id, join_order, display_name, platform, session_hash, reconnect_hash, " +
  "lobby_waiting, socket_generation, lease_until_ms, joined_at_ms, discord_user_id, " +
  "avatar_url";

const toRoomPlayer = (r: RoomPlayerSqlRow): RoomPlayer => ({
  playerId: r.player_id,
  joinOrder: r.join_order,
  displayName: r.display_name,
  platform: r.platform,
  discordUserId: r.discord_user_id,
  avatarUrl: r.avatar_url,
  sessionHash: r.session_hash,
  reconnectHash: r.reconnect_hash,
  lobbyWaiting: r.lobby_waiting !== 0,
  socketGeneration: r.socket_generation,
  leaseUntilMs: r.lease_until_ms,
  joinedAtMs: r.joined_at_ms,
});

export const roomPlayerCount = (sql: SqlStorage): number =>
  sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM room_players").one().n;

// Task 24 `leave`: removes the membership row outright. The member's
// session/reconnect hashes die with the row — a leaver can only return
// through a fresh invite join.
export const deleteRoomPlayer = (sql: SqlStorage, playerId: string): void => {
  sql.exec("DELETE FROM room_players WHERE player_id = ?", playerId);
  sql.exec("DELETE FROM ws_tickets WHERE player_id = ?", playerId);
};

export const insertRoomPlayer = (sql: SqlStorage, p: RoomPlayer): void => {
  sql.exec(
    `INSERT INTO room_players (${ROOM_PLAYER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    p.playerId,
    p.joinOrder,
    p.displayName,
    p.platform,
    p.sessionHash,
    p.reconnectHash,
    p.lobbyWaiting ? 1 : 0,
    p.socketGeneration,
    p.leaseUntilMs,
    p.joinedAtMs,
    p.discordUserId,
    p.avatarUrl,
  );
};

const findPlayerBy = (sql: SqlStorage, column: string, hash: string): RoomPlayer | null => {
  const row = sql
    .exec<RoomPlayerSqlRow>(
      `SELECT ${ROOM_PLAYER_COLUMNS} FROM room_players WHERE ${column} = ?`,
      hash,
    )
    .toArray()[0];
  return row === undefined ? null : toRoomPlayer(row);
};

export const findPlayerBySessionHash = (sql: SqlStorage, hash: string): RoomPlayer | null =>
  findPlayerBy(sql, "session_hash", hash);

export const findPlayerByReconnectHash = (sql: SqlStorage, hash: string): RoomPlayer | null =>
  findPlayerBy(sql, "reconnect_hash", hash);

// Task 35 seat dedupe: the verified Discord user id — never a
// client-declared value — resolves the seat a rejoin reclaims.
export const findPlayerByDiscordId = (
  sql: SqlStorage,
  discordUserId: string,
): RoomPlayer | null => {
  const row = sql
    .exec<RoomPlayerSqlRow>(
      `SELECT ${ROOM_PLAYER_COLUMNS} FROM room_players WHERE discord_user_id = ?`,
      discordUserId,
    )
    .toArray()[0];
  return row === undefined ? null : toRoomPlayer(row);
};

// Rejoin on an existing seat: rotate both token hashes and refresh the
// stored name/avatar when the verified profile changed them.
export const updateDiscordSeat = (
  sql: SqlStorage,
  playerId: string,
  sessionHash: string,
  reconnectHash: string,
  displayName: string | null,
  avatarUrl: string | null,
): void => {
  sql.exec(
    "UPDATE room_players SET session_hash = ?, reconnect_hash = ?, display_name = ?, avatar_url = ? WHERE player_id = ?",
    sessionHash,
    reconnectHash,
    displayName,
    avatarUrl,
    playerId,
  );
};

export const updateSessionHashes = (
  sql: SqlStorage,
  playerId: string,
  sessionHash: string,
  reconnectHash: string,
): void => {
  sql.exec(
    "UPDATE room_players SET session_hash = ?, reconnect_hash = ? WHERE player_id = ?",
    sessionHash,
    reconnectHash,
    playerId,
  );
};

// A replacement socket bumps the generation so the old socket's close can
// never remove the new one's presence (full presence logic is Task 20).
export const bumpSocketGeneration = (sql: SqlStorage, playerId: string): number => {
  sql.exec(
    "UPDATE room_players SET socket_generation = socket_generation + 1 WHERE player_id = ?",
    playerId,
  );
  return sql
    .exec<{ g: number }>(
      "SELECT socket_generation AS g FROM room_players WHERE player_id = ?",
      playerId,
    )
    .one().g;
};

export const findRoomPlayer = (sql: SqlStorage, playerId: string): RoomPlayer | null => {
  const row = sql
    .exec<RoomPlayerSqlRow>(
      `SELECT ${ROOM_PLAYER_COLUMNS} FROM room_players WHERE player_id = ?`,
      playerId,
    )
    .toArray()[0];
  return row === undefined ? null : toRoomPlayer(row);
};

export const listRoomPlayers = (sql: SqlStorage): RoomPlayer[] =>
  sql
    .exec<RoomPlayerSqlRow>(`SELECT ${ROOM_PLAYER_COLUMNS} FROM room_players ORDER BY join_order`)
    .toArray()
    .map(toRoomPlayer);

// The liveness lease in milliseconds-since-epoch; NULL marks disconnected.
// Task 20 owns the full heartbeat/lease semantics — Task 19 only tracks
// last-seen through this column.
export const writeLease = (
  sql: SqlStorage,
  playerId: string,
  leaseUntilMs: number | null,
): void => {
  sql.exec(
    "UPDATE room_players SET lease_until_ms = ? WHERE player_id = ?",
    leaseUntilMs,
    playerId,
  );
};

// Pending lobby settings set by updateLobby before the game exists; the
// JSON is the lobbySettingsSchema payload, validated at the envelope.
export const readLobbySettings = (sql: SqlStorage): string | null =>
  sql.exec<{ json: string }>("SELECT json FROM lobby_settings WHERE id = 1").toArray()[0]?.json ??
  null;

export const writeLobbySettings = (sql: SqlStorage, json: string): void => {
  sql.exec("INSERT OR REPLACE INTO lobby_settings (id, json) VALUES (1, ?)", json);
};
