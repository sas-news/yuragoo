// DDL for the GameRoom SQLite schema. ensureSchema runs on every Durable
// Object construction; every statement is CREATE TABLE IF NOT EXISTS so a
// same-version re-run is always a no-op (the migration acceptance test).
// The schema_version itself lives in the single room_meta row, not here —
// recovery.ts refuses the room when it carries an unknown version.
import { schemaVersion } from "@yuragoo/protocol";

export const ROOM_SCHEMA_VERSION = schemaVersion;

// room_meta is a single-row (id = 1) wide row holding the room ledger:
// epoch, the accepted-post counter (input_seq == GameState.seq), the event
// counter (state_revision == events.seq), phase, the GameState snapshot,
// resolved settings, attempt quotas and the creation clock.
const STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS room_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL,
    game_epoch INTEGER NOT NULL,
    input_seq INTEGER NOT NULL,
    state_revision INTEGER NOT NULL,
    phase TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    settings TEXT NOT NULL,
    jev_attempts INTEGER NOT NULL DEFAULT 0,
    generation_attempts INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS players (
    player_id TEXT PRIMARY KEY,
    join_order INTEGER NOT NULL,
    lease_until_ms INTEGER,
    platform TEXT NOT NULL
  )`,
  // Command dedupe: one row per (player_id, command_id). The stored ack is
  // the full ApplyResult JSON so a replayed command returns the same ack.
  `CREATE TABLE IF NOT EXISTS commands (
    player_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    ack TEXT NOT NULL,
    PRIMARY KEY (player_id, command_id)
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL
  )`,
  // One armed row per tag; the room's single alarm is always min(run_at).
  `CREATE TABLE IF NOT EXISTS deadlines (
    id TEXT PRIMARY KEY,
    run_at INTEGER NOT NULL,
    tag TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_jobs (
    token TEXT PRIMARY KEY,
    cutoff_seq INTEGER NOT NULL,
    state TEXT NOT NULL
  )`,
  // Task 22: landed distributions keyed by postId — the room needs them
  // for the server-side settle claim; the wire decisionUpdated event is
  // persisted in the shared events table instead.
  `CREATE TABLE IF NOT EXISTS ai_results (
    post_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  )`,
  // Task 22 generation budget gate: one row per spent normal-LLM slot
  // ('pre' = pre-game, 'post' = post-game) — at most one each per game.
  `CREATE TABLE IF NOT EXISTS generation_slots (
    slot TEXT PRIMARY KEY,
    spent_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ending (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    panel TEXT,
    pose TEXT
  )`,
  // Room-auth (Task 18): the invite secret's SHA-256 hash, held for the
  // room's whole lifetime. Written by initRoom (or the create path).
  `CREATE TABLE IF NOT EXISTS room_auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    invite_hash TEXT NOT NULL,
    platform TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  // Room membership ledger — hash-only credentials, socket generation and
  // the lobby-waiting flag for mid-game joins. Not the game roster: the
  // `players` table holds the per-game roster snapshot instead.
  // discord_user_id (Task 35): the verified Discord user id behind the
  // seat, or NULL for browser seats — it is what makes a Discord rejoin
  // land back on the same player row.
  `CREATE TABLE IF NOT EXISTS room_players (
    player_id TEXT PRIMARY KEY,
    join_order INTEGER NOT NULL,
    display_name TEXT,
    platform TEXT NOT NULL,
    discord_user_id TEXT,
    session_hash TEXT NOT NULL,
    reconnect_hash TEXT NOT NULL,
    lobby_waiting INTEGER NOT NULL DEFAULT 0,
    socket_generation INTEGER NOT NULL DEFAULT 0,
    lease_until_ms INTEGER,
    joined_at_ms INTEGER NOT NULL
  )`,
  // Pending host-tunable lobby settings (updateLobby), applied at game
  // create. Lives outside room_meta because it is written pre-game.
  `CREATE TABLE IF NOT EXISTS lobby_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL
  )`,
  // Task 24 shared lobby ledger: the host-editable scenario + per-seat
  // choice drafts + ready flags. choices/ready are JSON; committed_count
  // records how many leading choices startGame committed (0 = not yet).
  // choiceIds inside `choices` are server-assigned at growth and stable
  // across edits, leaves and re-joins — shrunk counts orphan the tail,
  // never delete it.
  `CREATE TABLE IF NOT EXISTS lobby (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0,
    scenario TEXT NOT NULL DEFAULT '',
    choices TEXT NOT NULL DEFAULT '[]',
    ready TEXT NOT NULL DEFAULT '[]',
    committed_count INTEGER NOT NULL DEFAULT 0
  )`,
  // Task 26: the server watcher's sustained-dominance streak — dominant
  // roster slot + the honest clock start. Persisted so an evicted DO
  // reconstructs it; cleared on rematch/close alongside the 'dwell'
  // deadline row that schedules the early-end check.
  `CREATE TABLE IF NOT EXISTS early_watch (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    slot INTEGER NOT NULL,
    since_ms INTEGER NOT NULL
  )`,
  // Single-use WS upgrade tickets (hash only), 30-second TTL, deleted on
  // consumption inside the same transaction that admits the socket.
  `CREATE TABLE IF NOT EXISTS ws_tickets (
    ticket_hash TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`,
  // Room presence ledger (Task 20): the elected host (room_players row),
  // the last-connection-gone timestamp driving the empty grace window, the
  // pause-start timestamp (set only when the room emptied during playing),
  // and the terminal expired flag Task 21 hooks for deletion.
  `CREATE TABLE IF NOT EXISTS room_presence (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    host_player_id TEXT,
    empty_since_ms INTEGER,
    paused_at_ms INTEGER,
    expired INTEGER NOT NULL DEFAULT 0
  )`,
  // Playing-phase clocks parked while the room is empty (Task 20). Rows
  // hold the REMAINING time (run_at - pausedAt) so a resume can restore
  // them shifted by the paused duration — settle/generation deadlines are
  // never parked here.
  `CREATE TABLE IF NOT EXISTS paused_deadlines (
    id TEXT PRIMARY KEY,
    remaining_ms INTEGER NOT NULL,
    tag TEXT NOT NULL
  )`,
  // Room-lifetime counters (Task 21): games_finished drives the 20-game
  // cap; evaluation marks dev/eval rooms whose games never reach the
  // public aggregates. Written at first finish / create-with-eval.
  `CREATE TABLE IF NOT EXISTS room_lifetime (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    games_finished INTEGER NOT NULL DEFAULT 0,
    evaluation INTEGER NOT NULL DEFAULT 0
  )`,
  // Anonymous aggregate outbox (Task 21): one row per pending submission,
  // retried only while the room lives (<=5min window), discarded by
  // deleteAll at close — a pending send never delays deletion.
  `CREATE TABLE IF NOT EXISTS outbox (
    receipt_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    next_retry_at_ms INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  )`,
  // Close tombstone (Task 21): the ONLY row allowed to survive a deleted
  // room. 'pending' = the wipe is being retried; 'done' = fully deleted.
  // Holds no user data — just the deletion bookkeeping that keeps the
  // room refusing access forever without resurrecting content.
  `CREATE TABLE IF NOT EXISTS room_tombstone (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    closed_at_ms INTEGER NOT NULL,
    wipe_state TEXT NOT NULL,
    wipe_attempts INTEGER NOT NULL DEFAULT 0
  )`,
];

export const ensureSchema = (sql: SqlStorage): void => {
  for (const statement of STATEMENTS) {
    sql.exec(statement);
  }
  // Additive column migration (Task 22): `tries` counts durable sends so a
  // bounded retry survives an eviction. CREATE TABLE above can't alter an
  // existing database, so add the column once when it's missing.
  const jobColumns = sql
    .exec<{ name: string }>("PRAGMA table_info(ai_jobs)")
    .toArray()
    .map((c) => c.name);
  if (!jobColumns.includes("tries")) {
    sql.exec("ALTER TABLE ai_jobs ADD COLUMN tries INTEGER NOT NULL DEFAULT 0");
  }
  // Additive column migration (Task 35): discord_user_id seats a verified
  // Discord user. The partial unique index enforces seat dedupe — at most
  // one room seat per Discord account — without colliding on the NULLs
  // every browser row carries.
  const playerColumns = sql
    .exec<{ name: string }>("PRAGMA table_info(room_players)")
    .toArray()
    .map((c) => c.name);
  if (!playerColumns.includes("discord_user_id")) {
    sql.exec("ALTER TABLE room_players ADD COLUMN discord_user_id TEXT");
  }
  sql.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS room_players_discord " +
      "ON room_players (discord_user_id) WHERE discord_user_id IS NOT NULL",
  );
};
