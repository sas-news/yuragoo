// Anonymous public aggregates (Task 21): global totals ONLY —
// {completedGames,totalMessages,totalDurationMs} plus the derived average
// duration. No display names, player ids, room ids, text, custom choice
// names, individual winners or per-room stats may ever be stored or
// returned here.
//
// Accumulation: each accepted receipt adds its delta to the all-time
// totals row AND to the submission day's aggregate_days bucket. Public
// reads expose only UTC-day buckets for days BEFORE today ("daily
// aggregation updates on UTC-day boundary covering days before today"),
// and stay "pending" until the published totals cover >= 20 completed
// games — the contract's small-numbers privacy guard.
import { expireReceipts, findReceipt, insertReceipt, RECEIPT_DEDUPE_MS } from "./receipts";
import { utcDay } from "./budgets";

export interface AggregateTotals {
  readonly completedGames: number;
  readonly totalMessages: number;
  readonly totalDurationMs: number;
}

// Kept for external readers — the 24h dedupe window (receipts.ts owns the
// longer physical retention that makes >24h refusals possible).
export const AGGREGATE_RETENTION_MS = RECEIPT_DEDUPE_MS;
export const PUBLIC_MIN_GAMES = 20;
const RECEIPT_ID_MAX = 160;
// Sanity bounds on a single delta — the contract's payload is numbers
// only; absurd magnitudes are refused as malformed, never clamped.
const MAX_GAMES_DELTA = 1_000;
const MAX_MESSAGES_DELTA = 1_000_000;
const MAX_DURATION_DELTA_MS = 365 * 24 * 60 * 60 * 1000;

export type SubmitAggregateResult =
  | { readonly ok: true; readonly dedupe: boolean }
  | { readonly ok: false; readonly reason: string };

export type PublicStats =
  | { readonly status: "pending" }
  | {
      readonly status: "ok";
      readonly completedGames: number;
      readonly totalMessages: number;
      readonly totalDurationMs: number;
      readonly averageDurationMs: number;
    };

const isNonNegInt = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

// One submission inside the caller's transactionSync: dedupe first, then
// accumulate. A receipt already seen within 24h is an idempotent replay
// (counts once); older than 24h it is refused and never recounted.
export const recordAggregate = (
  sql: SqlStorage,
  input: AggregateTotals & { readonly receiptId: string },
  nowMs: number,
): SubmitAggregateResult => {
  const { receiptId, completedGames, totalMessages, totalDurationMs } = input;
  if (typeof receiptId !== "string" || receiptId === "" || receiptId.length > RECEIPT_ID_MAX) {
    return { ok: false, reason: "bad-request" };
  }
  if (
    !isNonNegInt(completedGames) ||
    completedGames < 1 ||
    completedGames > MAX_GAMES_DELTA ||
    !isNonNegInt(totalMessages) ||
    totalMessages > MAX_MESSAGES_DELTA ||
    !isNonNegInt(totalDurationMs) ||
    totalDurationMs > MAX_DURATION_DELTA_MS
  ) {
    return { ok: false, reason: "bad-request" };
  }
  const seenAt = findReceipt(sql, receiptId);
  if (seenAt !== null) {
    if (nowMs - seenAt <= RECEIPT_DEDUPE_MS) return { ok: true, dedupe: true };
    return { ok: false, reason: "stale-receipt" }; // >24h: refused, no recount
  }
  insertReceipt(sql, receiptId, nowMs);
  const day = utcDay(nowMs);
  sql.exec(
    "INSERT INTO aggregate_days (day, completed_games, total_messages, total_duration_ms) " +
      "VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(day) DO UPDATE SET " +
      "completed_games = completed_games + excluded.completed_games, " +
      "total_messages = total_messages + excluded.total_messages, " +
      "total_duration_ms = total_duration_ms + excluded.total_duration_ms",
    day,
    completedGames,
    totalMessages,
    totalDurationMs,
  );
  sql.exec(
    "INSERT INTO aggregate_totals (id, completed_games, total_messages, total_duration_ms) " +
      "VALUES (1, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "completed_games = completed_games + excluded.completed_games, " +
      "total_messages = total_messages + excluded.total_messages, " +
      "total_duration_ms = total_duration_ms + excluded.total_duration_ms",
    completedGames,
    totalMessages,
    totalDurationMs,
  );
  expireReceipts(sql, nowMs);
  return { ok: true, dedupe: false };
};

// Internal all-time totals — ops/test visibility only, never the public
// payload (the public payload is the day-boundary view below).
export const readAggregateTotals = (sql: SqlStorage): AggregateTotals => {
  const row = sql
    .exec<{
      completed_games: number;
      total_messages: number;
      total_duration_ms: number;
    }>(
      "SELECT completed_games, total_messages, total_duration_ms FROM aggregate_totals WHERE id = 1",
    )
    .toArray()[0];
  return {
    completedGames: row?.completed_games ?? 0,
    totalMessages: row?.total_messages ?? 0,
    totalDurationMs: row?.total_duration_ms ?? 0,
  };
};

// The public read: sums over completed UTC days only, pending until the
// published totals cover PUBLIC_MIN_GAMES completed games.
export const readPublicStats = (sql: SqlStorage, nowMs: number): PublicStats => {
  const today = utcDay(nowMs);
  const row = sql
    .exec<{ g: number | null; m: number | null; d: number | null }>(
      "SELECT SUM(completed_games) AS g, SUM(total_messages) AS m, " +
        "SUM(total_duration_ms) AS d FROM aggregate_days WHERE day < ?",
      today,
    )
    .toArray()[0];
  const games = row?.g ?? 0;
  const messages = row?.m ?? 0;
  const duration = row?.d ?? 0;
  if (games < PUBLIC_MIN_GAMES) return { status: "pending" };
  return {
    status: "ok",
    completedGames: games,
    totalMessages: messages,
    totalDurationMs: duration,
    averageDurationMs: Math.round(duration / games),
  };
};
