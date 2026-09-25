// Anonymous-aggregate outbox (Task 21). When a game finishes, one numbers-
// only delta ({completedGames,totalMessages,totalDurationMs}) is enqueued
// under a random receiptId that is unrelated to room/player/game. The
// room retries submission while it lives — bounded by a 5-minute window
// per row — and deleteAll() discards whatever is still pending at close:
// submission never delays deletion, and transient aggregate loss is
// acceptable per the contract.
//
// Retry mechanics reuse the room's single alarm: the 'outbox-flush'
// deadline row points at the earliest pending retry, and alarm.ts hands
// the tag to driveOutbox instead of the game-deadline path. Flush results:
//   resolved (accepted OR refused) -> delete the row (refusals are
//     terminal — a stale/invalid receipt can never succeed)
//   threw (ControlPlane unreachable) -> reschedule within the window,
//     else drop the row.
import type { GameState } from "@yuragoo/game-core";
import { randomToken } from "../auth/invites";
import type { AggregateTotals, SubmitAggregateResult } from "../control/aggregates";
import { CONTROL_PLANE_NAME } from "../control/ControlPlane";
import type { ServerBindings } from "../config";
import { deleteDeadlineIds, replaceDeadline } from "./deadlines";
import { bumpGamesFinished, isEvaluationRoom } from "./limits";
import { OUTBOX_FLUSH_TAG } from "./leases";

// Each submission retries only while the room lives and only for this
// long — the contract's "max 5-minute retry window".
export const OUTBOX_RETRY_WINDOW_MS = 5 * 60 * 1000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_STEP_MS = 60_000;
const RECEIPT_BYTES = 16; // 128-bit random id — unrelated to room/player/game

// The slice of the ControlPlane stub the outbox uses.
export interface AggregateSink {
  submitAggregate(
    input: AggregateTotals & { readonly receiptId: string; readonly nowMs?: number },
  ): Promise<SubmitAggregateResult>;
}

export interface OutboxDeps {
  readonly control: AggregateSink | null;
  readonly nowMs: () => number;
}

// Test seam — mirrors injectDecisionJobDeps: replace the ControlPlane
// resolution and/or the clock.
let injectedDeps: Partial<OutboxDeps> | null = null;
export const injectOutboxDeps = (deps: Partial<OutboxDeps> | null): void => {
  injectedDeps = deps;
};

export const resolveOutboxDeps = (env: ServerBindings): OutboxDeps => {
  const ns = env.CONTROL_PLANE;
  const envControl: AggregateSink | null =
    ns === undefined ? null : ns.get(ns.idFromName(CONTROL_PLANE_NAME));
  return {
    control: injectedDeps?.control !== undefined ? injectedDeps.control : envControl,
    nowMs: injectedDeps?.nowMs ?? (() => Date.now()),
  };
};

export interface OutboxRow {
  readonly receiptId: string;
  readonly payload: string;
  readonly createdAtMs: number;
  readonly nextRetryAtMs: number;
  readonly attempts: number;
}

type OutboxSqlRow = {
  receipt_id: string;
  payload: string;
  created_at_ms: number;
  next_retry_at_ms: number;
  attempts: number;
};

const toRow = (r: OutboxSqlRow): OutboxRow => ({
  receiptId: r.receipt_id,
  payload: r.payload,
  createdAtMs: r.created_at_ms,
  nextRetryAtMs: r.next_retry_at_ms,
  attempts: r.attempts,
});

const OUTBOX_COLUMNS = "receipt_id, payload, created_at_ms, next_retry_at_ms, attempts";

export const insertOutbox = (
  sql: SqlStorage,
  receiptId: string,
  payload: string,
  nowMs: number,
): void => {
  sql.exec(
    `INSERT INTO outbox (${OUTBOX_COLUMNS}) VALUES (?, ?, ?, ?, 0)`,
    receiptId,
    payload,
    nowMs,
    nowMs,
  );
};

export const hasPendingOutbox = (sql: SqlStorage): boolean =>
  sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").one().n > 0;

export const listDueOutbox = (sql: SqlStorage, nowMs: number): OutboxRow[] =>
  sql
    .exec<OutboxSqlRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE next_retry_at_ms <= ? ORDER BY next_retry_at_ms`,
      nowMs,
    )
    .toArray()
    .map(toRow);

export const deleteOutbox = (sql: SqlStorage, receiptId: string): void => {
  sql.exec("DELETE FROM outbox WHERE receipt_id = ?", receiptId);
};

export const rescheduleOutbox = (
  sql: SqlStorage,
  receiptId: string,
  nextRetryAtMs: number,
  attempts: number,
): void => {
  sql.exec(
    "UPDATE outbox SET next_retry_at_ms = ?, attempts = ? WHERE receipt_id = ?",
    nextRetryAtMs,
    attempts,
    receiptId,
  );
};

// Point the room's outbox deadline at the earliest pending retry; remove
// it when the queue is empty so the alarm never wakes for nothing.
export const rearmOutboxDeadline = (sql: SqlStorage): void => {
  const min = sql
    .exec<{ m: number | null }>("SELECT MIN(next_retry_at_ms) AS m FROM outbox")
    .one().m;
  if (min === null) deleteDeadlineIds(sql, [OUTBOX_FLUSH_TAG]);
  else replaceDeadline(sql, OUTBOX_FLUSH_TAG, min, OUTBOX_FLUSH_TAG);
};

// commitAction hook — called inside the committing transactionSync when a
// transition lands in "finished". Bumps the room's finished-game counter
// (the 20-game cap counts every settled game), then enqueues the numbers-
// only aggregate delta unless the game is excluded from public stats
// (noContest outcomes and dev/eval rooms never count).
export const onGameFinished = (
  sql: SqlStorage,
  prev: GameState | null,
  next: GameState,
  nowMs: number,
): void => {
  if (next.phase !== "finished" || prev?.phase === "finished") return;
  bumpGamesFinished(sql);
  const outcome = next.outcome;
  if (outcome === null || outcome.kind === "noContest") return;
  if (isEvaluationRoom(sql)) return;
  const payload: AggregateTotals = {
    completedGames: 1,
    totalMessages: next.seq,
    totalDurationMs: Math.max(0, nowMs - next.startedAtMs),
  };
  insertOutbox(sql, randomToken(RECEIPT_BYTES), JSON.stringify(payload), nowMs);
  replaceDeadline(sql, OUTBOX_FLUSH_TAG, nowMs, OUTBOX_FLUSH_TAG);
};

const retryDelayMs = (attempts: number): number =>
  Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_STEP_MS);

// The GameRoom surface the flush needs (GameRoom implements it via
// driveOutbox — single-flight like the decision-job drive).
export interface OutboxHost {
  readonly sql: SqlStorage;
  txn<T>(fn: () => T): T;
  rearm(): Promise<void>;
}

const retryOrDrop = (sql: SqlStorage, row: OutboxRow, nowMs: number): void => {
  if (nowMs < row.createdAtMs + OUTBOX_RETRY_WINDOW_MS) {
    rescheduleOutbox(sql, row.receiptId, nowMs + retryDelayMs(row.attempts), row.attempts + 1);
  } else {
    // Window exhausted — transient loss is acceptable; never block a room.
    deleteOutbox(sql, row.receiptId);
  }
};

export const flushOutbox = async (host: OutboxHost, deps: OutboxDeps): Promise<void> => {
  const nowMs = deps.nowMs();
  const due = host.txn(() => listDueOutbox(host.sql, nowMs));
  for (const row of due) {
    let payload: AggregateTotals;
    try {
      payload = JSON.parse(row.payload) as AggregateTotals;
    } catch {
      // A row we can never serialize correctly is dropped, not retried.
      host.txn(() => deleteOutbox(host.sql, row.receiptId));
      continue;
    }
    let delivered = true;
    if (deps.control !== null) {
      try {
        await deps.control.submitAggregate({
          receiptId: row.receiptId,
          completedGames: payload.completedGames,
          totalMessages: payload.totalMessages,
          totalDurationMs: payload.totalDurationMs,
          nowMs,
        });
      } catch {
        delivered = false;
      }
    } else {
      delivered = false;
    }
    host.txn(() => {
      if (delivered) deleteOutbox(host.sql, row.receiptId);
      else retryOrDrop(host.sql, row, nowMs);
    });
  }
  // Keep the room's single alarm pointed at the next pending retry.
  host.txn(() => rearmOutboxDeadline(host.sql));
  await host.rearm();
};
