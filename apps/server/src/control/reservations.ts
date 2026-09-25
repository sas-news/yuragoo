// Reservation SQL for the ControlPlane DO (Task 22). The DO calls these
// inside its own transactionSync — every helper is synchronous storage
// math on (day, kind) rows plus the per-token idempotency ledger.
import {
  decideReservation,
  type MutateResult,
  type ReservationKind,
  type ReservationState,
  type ReserveResult,
} from "./budgets";

export interface ReservationRow {
  readonly [column: string]: SqlStorageValue;
  readonly token: string;
  readonly room_id: string;
  readonly day: string;
  readonly kind: string;
  readonly state: string;
  readonly created_at_ms: number;
}

type DayRow = { day: string; kind: string; reserved: number; consumed: number };

export const findReservation = (sql: SqlStorage, token: string): ReservationRow | null =>
  sql
    .exec<ReservationRow>(
      "SELECT token, room_id, day, kind, state, created_at_ms FROM reservations WHERE token = ?",
      token,
    )
    .toArray()[0] ?? null;

// The atomic grant step: idempotent on `token` (a replay returns the same
// grant; a released token stays dead forever). `budget` is the shared
// counter kind — "jev" covers ordinary AND final grants.
export const applyReserve = (
  sql: SqlStorage,
  input: { roomId: string; token: string; kind: ReservationKind; day: string },
  budget: "jev" | "generation",
  cap: number,
): ReserveResult => {
  const existing = findReservation(sql, input.token);
  const dayRow = sql
    .exec<DayRow>(
      "SELECT day, kind, reserved, consumed FROM budget_days WHERE day = ? AND kind = ?",
      input.day,
      budget,
    )
    .toArray()[0];
  const decision = decideReservation(
    cap,
    dayRow?.reserved ?? 0,
    (existing?.state as ReservationState | undefined) ?? null,
  );
  if (decision === "deny-released") return { ok: false, reason: "released" };
  if (decision === "deny-cap") return { ok: false, reason: "daily-cap" };
  if (existing === null) {
    sql.exec(
      "INSERT OR IGNORE INTO budget_days (day, kind, reserved, consumed) VALUES (?, ?, 0, 0)",
      input.day,
      budget,
    );
    sql.exec(
      "INSERT INTO reservations (token, room_id, day, kind, state, created_at_ms) " +
        "VALUES (?, ?, ?, ?, 'reserved', ?)",
      input.token,
      input.roomId,
      input.day,
      input.kind,
      Date.now(),
    );
    sql.exec(
      "UPDATE budget_days SET reserved = reserved + 1 WHERE day = ? AND kind = ?",
      input.day,
      budget,
    );
  }
  return { ok: true, day: input.day, kind: input.kind };
};

// Confirm an outcome for a grant — success OR failure, the attempt was
// used. Idempotent; a released/unknown token can never become consumed.
export const applyConsume = (sql: SqlStorage, token: string): MutateResult => {
  const row = findReservation(sql, token);
  if (row === null) return { ok: false, reason: "unknown-token" };
  if (row.state === "consumed") return { ok: true };
  if (row.state === "released") return { ok: false, reason: "released" };
  sql.exec("UPDATE reservations SET state = 'consumed' WHERE token = ?", token);
  sql.exec(
    "UPDATE budget_days SET consumed = consumed + 1 WHERE day = ? AND kind = ?",
    row.day,
    row.kind === "generation" ? "generation" : "jev",
  );
  return { ok: true };
};

// Free a grant that provably never reached the wire. Only a still
// "reserved" row may release — a consumed or absent grant stays counted.
export const applyRelease = (sql: SqlStorage, token: string): MutateResult => {
  const row = findReservation(sql, token);
  if (row === null) return { ok: false, reason: "unknown-token" };
  if (row.state !== "reserved") return { ok: false, reason: row.state };
  sql.exec("UPDATE reservations SET state = 'released' WHERE token = ?", token);
  sql.exec(
    "UPDATE budget_days SET reserved = reserved - 1 WHERE day = ? AND kind = ?",
    row.day,
    row.kind === "generation" ? "generation" : "jev",
  );
  return { ok: true };
};
