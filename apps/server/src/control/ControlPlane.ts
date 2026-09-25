// The ControlPlane Durable Object (Task 22): ONE instance per deployment —
// callers resolve it with idFromName("control-v1"). It owns the atomic
// daily attempt reservation ledger, the active-room registry and (Task 21
// seam) the anonymous aggregate receipts. All budget decisions are pure
// (./budgets) and every mutation happens inside transactionSync on its own
// SQLite store (./reservations), so concurrent rooms can never push a day
// over cap.
//
// Budget model: `budget_days(day, kind)` holds `reserved` (grants still
// counted against the cap — a grant that was maybe-sent stays counted) and
// `consumed` (grants the caller confirmed reached an outcome). `release`
// frees a slot ONLY when the upstream send provably never happened (the
// room never marked the job "sent"). "jev" and "jev-final" share the Jev
// budget (the final-slot rule is per-game, not per-day); "generation" is
// the separate normal-LLM counter.
import { DurableObject } from "cloudflare:workers";
import type { ServerBindings } from "../config";
import {
  type AggregateTotals,
  type PublicStats,
  readAggregateTotals,
  readPublicStats,
  recordAggregate,
  type SubmitAggregateResult,
} from "./aggregates";
import {
  isValidDay,
  type MutateResult,
  parseCap,
  parseReservationKind,
  type ReserveResult,
} from "./budgets";
import {
  expireRoomRows,
  findRoomRow,
  listRoomRows,
  registerRoomRow,
  revokeRoomRow,
  ROOM_REGISTRY_TTL_MS,
  type RoomRegistration,
} from "./registry";
import { applyConsume, applyRelease, applyReserve } from "./reservations";

export const CONTROL_PLANE_NAME = "control-v1";

const STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS budget_days (
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    reserved INTEGER NOT NULL DEFAULT 0,
    consumed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS reservations (
    token TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rooms (
    room_id TEXT PRIMARY KEY,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  )`,
  // Task 21: anonymous aggregate receipts (24h dedupe; the only thing
  // kept about a submission) and the numbers-only totals they feed.
  `CREATE TABLE IF NOT EXISTS aggregate_receipts (
    receipt_id TEXT PRIMARY KEY,
    received_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS aggregate_days (
    day TEXT PRIMARY KEY,
    completed_games INTEGER NOT NULL DEFAULT 0,
    total_messages INTEGER NOT NULL DEFAULT 0,
    total_duration_ms INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS aggregate_totals (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    completed_games INTEGER NOT NULL DEFAULT 0,
    total_messages INTEGER NOT NULL DEFAULT 0,
    total_duration_ms INTEGER NOT NULL DEFAULT 0
  )`,
];

export interface ReserveInput {
  readonly roomId: string;
  readonly token: string;
  readonly kind: string;
  readonly day: string;
}
export interface TokenInput {
  readonly token: string;
}
export interface RegisterRoomInput {
  readonly roomId: string;
  readonly nowMs: number;
  readonly ttlMs?: number;
}
export type { MutateResult } from "./budgets";
export interface DayLedger {
  readonly day: string;
  readonly kind: string;
  readonly reserved: number;
  readonly consumed: number;
  readonly cap: number | null;
}

const TOKEN_MAX = 160;
const BUDGET_KINDS = ["jev", "generation"] as const;
type BudgetKind = (typeof BUDGET_KINDS)[number];

export class ControlPlane extends DurableObject<ServerBindings> {
  constructor(ctx: DurableObjectState, env: ServerBindings) {
    super(ctx, env);
    for (const statement of STATEMENTS) ctx.storage.sql.exec(statement);
  }

  private capFor(kind: BudgetKind): number | null {
    // Separate counters per contract; server-side env only — no client
    // input can ever reach this.
    return kind === "generation"
      ? parseCap(this.env.GENERATION_DAILY_ATTEMPTS)
      : parseCap(this.env.JEV_DAILY_ATTEMPT_CAP);
  }

  // Atomic daily reservation. Idempotent on `token`: replay returns the
  // same grant; a released or capped request denies without side effects.
  reserve(input: ReserveInput): ReserveResult {
    if (
      typeof input.roomId !== "string" ||
      input.roomId === "" ||
      typeof input.token !== "string" ||
      input.token === "" ||
      input.token.length > TOKEN_MAX ||
      !isValidDay(input.day)
    ) {
      return { ok: false, reason: "bad-request" };
    }
    const kind = parseReservationKind(input.kind);
    if (kind === null) return { ok: false, reason: "bad-request" };
    const budget: BudgetKind = kind === "generation" ? "generation" : "jev";
    const cap = this.capFor(budget);
    if (cap === null) return { ok: false, reason: "config" };
    return this.ctx.storage.transactionSync(() =>
      applyReserve(this.ctx.storage.sql, { ...input, kind }, budget, cap),
    );
  }

  consume(input: TokenInput): MutateResult {
    return this.ctx.storage.transactionSync(() => applyConsume(this.ctx.storage.sql, input.token));
  }

  release(input: TokenInput): MutateResult {
    return this.ctx.storage.transactionSync(() => applyRelease(this.ctx.storage.sql, input.token));
  }

  // --- active room registry (Task 21 consumes this mapping) -------------

  registerRoom(input: RegisterRoomInput): MutateResult {
    if (typeof input.roomId !== "string" || input.roomId === "" || !Number.isFinite(input.nowMs)) {
      return { ok: false, reason: "bad-request" };
    }
    const ttl = input.ttlMs !== undefined && input.ttlMs > 0 ? input.ttlMs : ROOM_REGISTRY_TTL_MS;
    this.ctx.storage.transactionSync(() => {
      registerRoomRow(this.ctx.storage.sql, input.roomId, input.nowMs, input.nowMs + ttl);
    });
    return { ok: true };
  }

  revokeRoom(input: { readonly roomId: string }): MutateResult {
    const found = this.ctx.storage.transactionSync(() => {
      expireRoomRows(this.ctx.storage.sql, Date.now());
      return revokeRoomRow(this.ctx.storage.sql, input.roomId);
    });
    return found ? { ok: true } : { ok: false, reason: "unknown-room" };
  }

  roomRegistration(roomId: string): RoomRegistration | null {
    return findRoomRow(this.ctx.storage.sql, roomId);
  }

  rooms(): RoomRegistration[] {
    return listRoomRows(this.ctx.storage.sql);
  }

  // --- anonymous aggregates (Task 21) -------------------------------------
  // Server-only RPC from GameRoom outboxes. Numbers only; the receiptId
  // dedupes for 24h and never maps back to a room/player/game.

  submitAggregate(
    input: AggregateTotals & { readonly receiptId: string; readonly nowMs?: number },
  ): SubmitAggregateResult {
    const nowMs =
      input.nowMs !== undefined && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
    return this.ctx.storage.transactionSync(() =>
      recordAggregate(this.ctx.storage.sql, input, nowMs),
    );
  }

  // Public stats for GET /api/stats: UTC-day buckets before today,
  // "pending" until they cover >= 20 completed games.
  publicStats(input?: { readonly nowMs?: number }): PublicStats {
    const nowMs =
      input?.nowMs !== undefined && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
    return readPublicStats(this.ctx.storage.sql, nowMs);
  }

  // Internal all-time totals (ops/test read — not the public payload).
  aggregateTotals(): AggregateTotals {
    return readAggregateTotals(this.ctx.storage.sql);
  }

  // Test/ops snapshot of one UTC day's budget rows (both budgets + the
  // effective caps). Read-only; "jev" folds ordinary and final grants.
  ledger(day: string): DayLedger[] {
    const rows = this.ctx.storage.sql
      .exec<{ kind: string; reserved: number; consumed: number }>(
        "SELECT kind, reserved, consumed FROM budget_days WHERE day = ?",
        day,
      )
      .toArray();
    return BUDGET_KINDS.map((kind) => {
      const row = rows.find((r) => r.kind === kind);
      return {
        day,
        kind,
        reserved: row?.reserved ?? 0,
        consumed: row?.consumed ?? 0,
        cap: this.capFor(kind),
      };
    });
  }
}
