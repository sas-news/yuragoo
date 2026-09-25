// Constructor-side recovery for the GameRoom Durable Object. loadRoom is a
// pure synchronous read over SQLite storage — it never initializes an
// empty database (creation only ever happens through the internal
// createRoom RPC) and it fails closed whenever persisted rows exist but
// are unreadable or carry an unknown schema version.
import type { GameState } from "@yuragoo/game-core";
import { readRoomAuth } from "./auth-storage";
import { readTombstone } from "./close";
import { ROOM_SCHEMA_VERSION } from "./schema";
import { type MetaRow, readMeta } from "./storage";

export interface RecoveredRoom {
  readonly meta: MetaRow;
  readonly state: GameState;
}

export type Recovery =
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly room: RecoveredRoom }
  | {
      readonly kind: "closed";
      readonly reason: string;
      // Task 21: a 'pending' tombstone means deleteAll was interrupted —
      // the constructor re-arms the wipe retry.
      readonly deletionPending: boolean;
    };

// Anything stored without a room_meta row is inconsistent — the meta row
// is written in the same transaction as everything else.
const NON_META_TABLES = [
  "players",
  "commands",
  "events",
  "deadlines",
  "ai_jobs",
  "early_watch",
  "ending",
  "outbox",
  "room_lifetime",
] as const;

const hasAnyRows = (sql: SqlStorage): boolean => {
  const counts = NON_META_TABLES.map((t) => `(SELECT COUNT(*) FROM ${t})`).join(" + ");
  const row = sql.exec<{ n: number | null }>(`SELECT ${counts} AS n`).one();
  return (row.n ?? 0) > 0;
};

const parseSnapshot = (json: string): GameState | null => {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) return null;
    if (typeof (value as { phase?: unknown }).phase !== "string") return null;
    return value as GameState;
  } catch {
    return null;
  }
};

export const loadRoom = (storage: { readonly sql: SqlStorage }): Recovery => {
  const sql = storage.sql;
  // A tombstone outranks everything: the room was retired on purpose and
  // stays closed forever (pending = the wipe itself is still retrying).
  const tombstone = readTombstone(sql);
  if (tombstone !== null) {
    return {
      kind: "closed",
      reason: "retired",
      deletionPending: tombstone.wipeState === "pending",
    };
  }
  const meta = readMeta(sql);
  if (meta === null) {
    // A lobby-only room — members joined but no game yet, or a finished
    // game that returned to the lobby via backToLobby — legitimately has
    // no meta row (meta is born at game create). room_auth is the marker
    // that the room was initialized on purpose; rows without it are
    // genuinely corrupt and stay fail-closed.
    if (readRoomAuth(sql) !== null) return { kind: "empty" };
    return hasAnyRows(sql)
      ? { kind: "closed", reason: "rows-without-meta", deletionPending: false }
      : { kind: "empty" };
  }
  if (meta.schemaVersion !== ROOM_SCHEMA_VERSION) {
    return {
      kind: "closed",
      reason: `unknown-schema-version:${meta.schemaVersion}`,
      deletionPending: false,
    };
  }
  const state = parseSnapshot(meta.snapshot);
  if (state === null) {
    return { kind: "closed", reason: "corrupt-snapshot", deletionPending: false };
  }
  return { kind: "ready", room: { meta, state } };
};
