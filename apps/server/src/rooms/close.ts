// Room-close orchestration (Task 21). Contract close sequence:
//   1. revoke the ControlPlane active mapping FIRST
//   2. invalidate the room (closed flag + dropped books = dead epoch)
//   3. close every socket
//   4. ctx.storage.deleteAll() — text, participants, tokens, alarms, jobs
//      and the pending aggregate outbox all die with the room.
//
// Durability: a room_tombstone row written after the wipe makes "closed"
// survive eviction, so a reconstructed DO still refuses access and can
// never be re-created on this id. A wipe that fails mid-flight leaves the
// tombstone 'pending': the room stays closed, refuses everything, and the
// 'wipe-retry' deadline row re-attempts via the room alarm (the
// constructor retries too, covering a restart mid-delete).
import type { ServerBindings } from "../config";
import { replaceDeadline } from "./deadlines";
import type { Books } from "./due";
import { WIPE_RETRY_TAG } from "./leases";
import { revokeActiveRoom } from "./room-registry";
import { ensureSchema } from "./schema";

// --- tombstone -----------------------------------------------------------

export type WipeState = "pending" | "done";

export interface Tombstone {
  readonly closedAtMs: number;
  readonly wipeState: WipeState;
  readonly wipeAttempts: number;
}

type TombstoneSqlRow = {
  closed_at_ms: number;
  wipe_state: string;
  wipe_attempts: number;
};

export const readTombstone = (sql: SqlStorage): Tombstone | null => {
  const row = sql
    .exec<TombstoneSqlRow>(
      "SELECT closed_at_ms, wipe_state, wipe_attempts FROM room_tombstone WHERE id = 1",
    )
    .toArray()[0];
  return row === undefined
    ? null
    : {
        closedAtMs: row.closed_at_ms,
        wipeState: row.wipe_state === "done" ? "done" : "pending",
        wipeAttempts: row.wipe_attempts,
      };
};

export const writeTombstone = (sql: SqlStorage, wipeState: WipeState): void => {
  sql.exec(
    "INSERT INTO room_tombstone (id, closed_at_ms, wipe_state, wipe_attempts) " +
      "VALUES (1, ?, ?, 0) " +
      "ON CONFLICT(id) DO UPDATE SET wipe_state = excluded.wipe_state",
    Date.now(),
    wipeState,
  );
};

const bumpWipeAttempts = (sql: SqlStorage): void => {
  sql.exec("UPDATE room_tombstone SET wipe_attempts = wipe_attempts + 1 WHERE id = 1");
};

// --- injected storage hooks (test seam for mid-flight delete failures) ---

export interface CloseHooks {
  deleteAll(storage: DurableObjectStorage): Promise<void>;
}

const defaultHooks: CloseHooks = {
  deleteAll: (storage) => storage.deleteAll(),
};

let hooks: CloseHooks = defaultHooks;
export const injectCloseHooksForTest = (injected: Partial<CloseHooks> | null): void => {
  hooks = { ...defaultHooks, ...injected };
};

// --- the close itself -----------------------------------------------------

const WIPE_RETRY_BASE_MS = 5_000;
const WIPE_RETRY_MAX_MS = 5 * 60 * 1000;

const wipeRetryDelayMs = (attempts: number): number =>
  Math.min(WIPE_RETRY_BASE_MS * 2 ** attempts, WIPE_RETRY_MAX_MS);

// The GameRoom surface the close path needs.
export interface CloseHost {
  readonly roomId: string;
  readonly sql: SqlStorage;
  storage(): DurableObjectStorage;
  txn<T>(fn: () => T): T;
  sockets(): readonly WebSocket[];
  setBooks(books: Books | null): void;
  markClosed(): void;
  isClosed(): boolean;
  rearm(): Promise<void>;
}

// One deleteAll attempt. Success: empty schema + a 'done' tombstone, so
// every later query sees real (empty) tables instead of missing-schema
// errors — the late-callback guards then no-op cleanly. Failure: a
// 'pending' tombstone + an armed 'wipe-retry' deadline row; the room stays
// closed and the error is swallowed (close still completes from the
// caller's view — deletion retries out of band).
const attemptWipe = async (host: CloseHost): Promise<void> => {
  try {
    await hooks.deleteAll(host.storage());
    ensureSchema(host.sql);
    writeTombstone(host.sql, "done");
    // deleteAll clears scheduled alarms already; be explicit so a stray
    // delivery can never race a half-wiped room.
    await host
      .storage()
      .deleteAlarm()
      .catch(() => {});
  } catch {
    try {
      ensureSchema(host.sql);
      writeTombstone(host.sql, "pending");
      bumpWipeAttempts(host.sql);
      const attempts = readTombstone(host.sql)?.wipeAttempts ?? 0;
      replaceDeadline(
        host.sql,
        WIPE_RETRY_TAG,
        Date.now() + wipeRetryDelayMs(attempts),
        WIPE_RETRY_TAG,
      );
      await host.rearm();
    } catch {
      // Even the marker write failed — the constructor re-arms on the
      // next load (tombstone may exist from an earlier attempt).
    }
  }
};

// The full close sequence — idempotent: a room already fully wiped
// returns immediately; a pending one retries the wipe.
export const retireRoom = async (
  host: CloseHost,
  ctx: Pick<DurableObjectState, "waitUntil">,
  env: ServerBindings,
): Promise<void> => {
  if (host.isClosed() && readTombstone(host.sql)?.wipeState === "done") return;
  // 1. Revoke FIRST: the active mapping must die before anything else
  // (best-effort — registry failure can never gate teardown).
  revokeActiveRoom(ctx, env, host.roomId);
  // 2. Invalidate the room: closed flag + dropped books. Every entrypoint
  //    refuses from here on; late AI/generation callbacks find no books.
  host.setBooks(null);
  host.markClosed();
  // 3. Close every socket — the roomClosed ledger row was already
  //    broadcast by the close command before teardown.
  for (const ws of host.sockets()) {
    try {
      ws.close(1000, "room-closed");
    } catch {
      // Already closing.
    }
  }
  // 4. Wipe. The outbox dies with everything else — submission never
  //    delays deletion.
  await attemptWipe(host);
};

// Alarm/constructor path: a room whose wipe is still pending retries it;
// a fully wiped room just sheds the stale scheduled alarm.
export const retryWipeIfPending = async (host: CloseHost): Promise<void> => {
  const tombstone = readTombstone(host.sql);
  if (tombstone === null || tombstone.wipeState === "done") {
    await host
      .storage()
      .deleteAlarm()
      .catch(() => {});
    return;
  }
  await attemptWipe(host);
};
