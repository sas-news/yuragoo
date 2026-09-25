// SQLite primitives for the GameRoom DO: bound parameters only, cursors
// consumed inside the call. commitAction is the atomic ledger step —
// reduce() then persist snapshot/events/deadlines/jobs/dedupe inside the
// caller's transactionSync so everything commits or rolls back together.
import type { GameAction, GameEvent, GameState } from "@yuragoo/game-core";
import { reduce } from "@yuragoo/game-core";
import { onGameFinished } from "./aggregate-outbox";
import { upsertAiJob } from "./ai-jobs";
import { replaceDeadline } from "./deadlines";

export type MetaRow = {
  readonly schemaVersion: number;
  readonly gameEpoch: number;
  readonly inputSeq: number;
  readonly stateRevision: number;
  readonly phase: string;
  readonly snapshot: string;
  readonly settings: string;
  readonly jevAttempts: number;
  readonly generationAttempts: number;
  readonly createdAtMs: number;
};

type MetaSqlRow = {
  schema_version: number;
  game_epoch: number;
  input_seq: number;
  state_revision: number;
  phase: string;
  snapshot: string;
  settings: string;
  jev_attempts: number;
  generation_attempts: number;
  created_at_ms: number;
};

const META_COLUMNS =
  "schema_version, game_epoch, input_seq, state_revision, phase, snapshot, " +
  "settings, jev_attempts, generation_attempts, created_at_ms";

const toMeta = (r: MetaSqlRow): MetaRow => ({
  schemaVersion: r.schema_version,
  gameEpoch: r.game_epoch,
  inputSeq: r.input_seq,
  stateRevision: r.state_revision,
  phase: r.phase,
  snapshot: r.snapshot,
  settings: r.settings,
  jevAttempts: r.jev_attempts,
  generationAttempts: r.generation_attempts,
  createdAtMs: r.created_at_ms,
});

export const readMeta = (sql: SqlStorage): MetaRow | null => {
  const row = sql
    .exec<MetaSqlRow>(`SELECT ${META_COLUMNS} FROM room_meta WHERE id = 1`)
    .toArray()[0];
  return row === undefined ? null : toMeta(row);
};

export const writeMeta = (sql: SqlStorage, m: MetaRow): void => {
  sql.exec(
    `INSERT OR REPLACE INTO room_meta (id, ${META_COLUMNS}) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    m.schemaVersion,
    m.gameEpoch,
    m.inputSeq,
    m.stateRevision,
    m.phase,
    m.snapshot,
    m.settings,
    m.jevAttempts,
    m.generationAttempts,
    m.createdAtMs,
  );
};

export const insertPlayers = (
  sql: SqlStorage,
  playerIds: readonly string[],
  platform: string,
): void => {
  for (const [index, id] of playerIds.entries()) {
    sql.exec(
      "INSERT INTO players (player_id, join_order, lease_until_ms, platform) VALUES (?, ?, NULL, ?)",
      id,
      index,
      platform,
    );
  }
};

export type CommandRow = { readonly fingerprint: string; readonly ack: string };

export const findCommand = (
  sql: SqlStorage,
  playerId: string,
  commandId: string,
): CommandRow | null =>
  sql
    .exec<CommandRow>(
      "SELECT fingerprint, ack FROM commands WHERE player_id = ? AND command_id = ?",
      playerId,
      commandId,
    )
    .toArray()[0] ?? null;

export const insertCommand = (
  sql: SqlStorage,
  playerId: string,
  commandId: string,
  fingerprint: string,
  ack: string,
): void => {
  sql.exec(
    "INSERT INTO commands (player_id, command_id, fingerprint, ack) VALUES (?, ?, ?, ?)",
    playerId,
    commandId,
    fingerprint,
    ack,
  );
};

export type EventRow = { readonly seq: number; readonly type: string; readonly payload: string };

export const insertEvent = (sql: SqlStorage, seq: number, type: string, payload: string): void => {
  sql.exec("INSERT INTO events (seq, type, payload) VALUES (?, ?, ?)", seq, type, payload);
};

export const listEvents = (sql: SqlStorage): EventRow[] =>
  sql.exec<EventRow>("SELECT seq, type, payload FROM events ORDER BY seq").toArray();

// The events table is the room's single event counter: game events AND
// room events (presenceChanged/hostChanged/roomClosed) share its seq
// space, and room_meta.state_revision always equals its max when a game
// exists. A fresh room has no meta row, so seq allocation must read the
// table itself rather than the meta counter.
export const maxEventSeq = (sql: SqlStorage): number =>
  sql.exec<{ m: number | null }>("SELECT COALESCE(MAX(seq), 0) AS m FROM events").one().m ?? 0;

export const nextEventSeq = (sql: SqlStorage): number => maxEventSeq(sql) + 1;

// Persist a room-lifetime event (presenceChanged / hostChanged /
// roomClosed — payload is already the wire shape) at the next shared seq
// and keep room_meta.state_revision in lockstep. Inside the caller's
// transactionSync this commits atomically with the mutation it describes.
export const recordRoomEvent = (sql: SqlStorage, type: string, payload: unknown): number => {
  const seq = nextEventSeq(sql);
  insertEvent(sql, seq, type, JSON.stringify(payload));
  sql.exec("UPDATE room_meta SET state_revision = ? WHERE id = 1", seq);
  return seq;
};

export interface DedupeKey {
  readonly playerId: string;
  readonly commandId: string;
  readonly fingerprint: string;
}

export interface AckPayload {
  readonly accepted: true;
  readonly inputSeq: number;
  readonly stateRevision: number;
}

export interface ApplyResult {
  readonly ack: AckPayload;
  readonly events: readonly { seq: number; event: GameEvent }[];
  readonly stateRevision: number;
}

export interface CommitOutcome {
  readonly meta: MetaRow;
  readonly state: GameState;
  readonly result: ApplyResult;
}

// reduce() -> persist transition. Throws (GameRuleError or SQLite error)
// before or during the writes; inside transactionSync every write made so
// far rolls back and this pure-output shape leaves the caller's in-memory
// books untouched until the commit is known to have succeeded.
export const commitAction = (
  sql: SqlStorage,
  meta: MetaRow,
  state: GameState | null,
  action: GameAction,
  dedupe?: DedupeKey,
): CommitOutcome => {
  const transition = reduce(state, action);
  // meta.stateRevision always equals MAX(events.seq): commitAction bumps it
  // per publish, recordRoomEvent bumps it per room row, and the callers
  // (commitPresence/commitAckOnly) re-sync the in-memory copy after every
  // room-event commit so this base can never go stale.
  let revision = meta.stateRevision;
  const events: { seq: number; event: GameEvent }[] = [];
  for (const command of transition.commands) {
    if (command.type === "publish") {
      revision += 1;
      insertEvent(sql, revision, command.event.type, JSON.stringify(command.event));
      events.push({ seq: revision, event: command.event });
    } else if (command.type === "set-deadline") {
      replaceDeadline(sql, command.tag, command.atMs, command.tag);
    } else if (command.type === "evaluate") {
      // Evaluation jobs are claimed by the AI runtime (later task); the
      // room persists them so a restart never silently loses work.
      upsertAiJob(sql, command.postId, command.seq, "pending");
    }
    // "finish" persists via the snapshot's outcome; "close-room" is a
    // room-lifecycle concern owned by a later task.
  }
  const next = transition.state;
  const nextMeta: MetaRow = {
    ...meta,
    inputSeq: next.seq,
    stateRevision: revision,
    phase: next.phase,
    snapshot: JSON.stringify(next),
    settings: JSON.stringify(next.settings),
  };
  writeMeta(sql, nextMeta);
  const result: ApplyResult = {
    ack: { accepted: true, inputSeq: next.seq, stateRevision: revision },
    events,
    stateRevision: revision,
  };
  if (dedupe !== undefined) {
    insertCommand(
      sql,
      dedupe.playerId,
      dedupe.commandId,
      dedupe.fingerprint,
      JSON.stringify(result),
    );
  }
  // Task 21: the finished-game hook (counter bump + aggregate outbox
  // enqueue) rides the same commit — every settle path funnels through
  // here, so a completion can never be counted or queued twice. Actions
  // that carry no clock (evaluated/abort) fall back to the wall clock.
  const finishedAtMs =
    "nowMs" in action && typeof action.nowMs === "number" ? action.nowMs : Date.now();
  onGameFinished(sql, state, next, finishedAtMs);
  return { meta: nextMeta, state: next, result };
};
